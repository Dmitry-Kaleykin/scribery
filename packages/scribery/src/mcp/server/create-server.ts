import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import {
    MCP_CODEBASE_CONTEXT_CHARACTERS,
    MCP_CODEBASE_CONTEXT_CHUNKS_AFTER,
    MCP_CODEBASE_CONTEXT_CHUNKS_BEFORE,
    MCP_CODEBASE_RESULT_LIMIT,
    MCP_DEFAULT_DOCUMENTATION_SOURCE_CHARACTERS,
    MCP_DEFAULT_RESULT_LIMIT,
    MCP_MAXIMUM_DOCUMENTATION_SOURCE_CHARACTERS,
    MCP_MAXIMUM_CHUNK_PAGE_SIZE,
    MCP_SERVER_NAME,
    READ_ONLY_TOOL_ANNOTATIONS,
} from "../constants/defaults.js";
import type { ScriberyMcpServerOptions } from "../contracts/server.js";
import {
    formatProjectSearchResult,
    projectSearchFailure,
} from "../results/project-search-result.js";
import { mcpToolFailure, mcpToolSuccess } from "../results/tool-result.js";
import { McpDocumentationService } from "../services/documentation-service.js";
import { McpProjectService } from "../services/project-service.js";
import { resolveMcpToolAllowlist } from "../tools/tool-allowlist.js";

const projectReference = z.string().trim().min(1).optional().describe(
    "Project name or source root. Omit it when the server is configured for " +
    "the project or only one project is available.",
);
const documentationReference = z.string().trim().min(1).describe(
    "Documentation name returned by list_documentations.",
);
const documentationSourceReference = z.string().trim().min(1).describe(
    "Source identifier or documentation-relative path returned by " +
    "search_documentation. To follow a file reference, resolve it to a " +
    "documentation-relative path and pass that path here.",
);
const query = z.string().trim().min(1).describe(
    "Natural-language retrieval query.",
);
const codebaseQuery = z.string().trim().min(1).describe(
    "Describe the implementation, behavior, or concept to find. Words that occur " +
    "in the code help, but they are not required.",
);
const resultLimit = z.number().int().min(1).max(100).optional().describe(
    `Maximum returned matches; defaults to ${MCP_DEFAULT_RESULT_LIMIT}.`,
);
const codebaseResultLimit = z.number().int().min(1).max(100).optional().describe(
    `Maximum matches to return; defaults to ${MCP_CODEBASE_RESULT_LIMIT}.`,
);
const contextFields = {
    includeContext: z.boolean().optional().describe(
        "Include neighboring chunks; defaults to true.",
    ),
    contextBefore: z.number().int().min(0).max(20).optional().describe(
        "Neighbor chunks before each match; defaults to 1.",
    ),
    contextAfter: z.number().int().min(0).max(20).optional().describe(
        "Neighbor chunks after each match; defaults to 1.",
    ),
    contextCharacters: z.number().int().min(1).max(100_000).optional().describe(
        "Combined neighboring-context character budget; defaults to 4000.",
    ),
};
const rerankingFields = {
    rerank: z.boolean().optional().describe(
        "Use the configured reranker; enabled automatically when available.",
    ),
    rerankCandidates: z.number().int().min(1).max(100).optional().describe(
        "Semantic candidates considered by the configured reranker.",
    ),
};

export function createScriberyMcpServer(
    options: ScriberyMcpServerOptions,
): McpServer {
    const enabledTools = resolveMcpToolAllowlist(options.toolAllowlist);
    const server = new McpServer(
        { name: MCP_SERVER_NAME, version: options.version },
        { instructions: createMcpInstructions(enabledTools) },
    );
    const projects = new McpProjectService(options);
    const documentations = new McpDocumentationService(options);
    const executeCodebaseSearch = async (
        input: { query: string; limit?: number },
        signal: AbortSignal,
    ) => {
        const limit = input.limit ?? MCP_CODEBASE_RESULT_LIMIT;

        try {
            const result = await projects.search({
                query: input.query,
                limit,
                contextBefore: MCP_CODEBASE_CONTEXT_CHUNKS_BEFORE,
                contextAfter: MCP_CODEBASE_CONTEXT_CHUNKS_AFTER,
                contextCharacters: MCP_CODEBASE_CONTEXT_CHARACTERS,
            }, signal);
            return mcpToolSuccess(
                result,
                formatProjectSearchResult(result, input.query, limit),
            );
        } catch (error: unknown) {
            return projectSearchFailure(error);
        }
    };

    if (enabledTools.has("list_projects")) server.registerTool(
        "list_projects",
        {
            title: "List projects",
            description: "List available source projects.",
            inputSchema: z.object({}),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        },
        async () => {
            try {
                return mcpToolSuccess(await projects.listProjects());
            } catch (error: unknown) {
                return mcpToolFailure(error);
            }
        },
    );

    if (enabledTools.has("search_codebase")) {
        server.registerTool(
            "search_codebase",
            {
                title: "Search the codebase",
                description:
                    "Find where a behavior lives in this project's source by " +
                    "describing it instead of naming it. Use it when you cannot " +
                    "recall the identifier, file, or wording — or when you want " +
                    "every place a concept appears gathered in one ranked pass. " +
                    "Results carry file paths, the line ranges returned, enclosing " +
                    "declarations, and surrounding source, so a follow-up call is " +
                    "often unnecessary. Searches the project this server was started " +
                    "with; an empty result names it and says how to reword.",
                inputSchema: z.object({
                    query: codebaseQuery,
                    limit: codebaseResultLimit,
                }),
                annotations: READ_ONLY_TOOL_ANNOTATIONS,
            },
            async (input, extra) =>
                executeCodebaseSearch({
                    query: input.query,
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                }, extra.signal),
        );
    }

    if (enabledTools.has("inspect_project_chunks")) server.registerTool(
        "inspect_project_chunks",
        {
            title: "Inspect file chunks",
            description:
                "Read more source from a file returned by search_codebase. " +
                "Use this when a search excerpt does not contain enough of the file.",
            inputSchema: z.object({
                path: z.string().trim().min(1).describe(
                    "Portable path relative to the project root.",
                ),
                project: projectReference,
                build: z.string().trim().min(1).optional(),
                start: z.number().int().min(0).optional().describe(
                    "Zero-based chunk position at which to start; defaults to 0.",
                ),
                limit: z.number().int().min(1)
                    .max(MCP_MAXIMUM_CHUNK_PAGE_SIZE).optional().describe(
                        "Maximum chunks returned; defaults to 20 and is capped at 100.",
                    ),
            }),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        },
        async (input) => {
            try {
                return mcpToolSuccess(await projects.chunks({
                    path: input.path,
                    ...(input.project === undefined
                        ? {}
                        : { projectReference: input.project }),
                    ...(input.build === undefined
                        ? {}
                        : { indexBuildId: input.build }),
                    ...(input.start === undefined ? {} : { start: input.start }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                }));
            } catch (error: unknown) {
                return mcpToolFailure(error);
            }
        },
    );

    if (enabledTools.has("list_documentations")) server.registerTool(
        "list_documentations",
        {
            title: "List documentation",
            description:
                "List the available documentation that can be searched with " +
                "search_documentation. Returns each documentation's name and " +
                "description so you can choose the relevant one.",
            inputSchema: z.object({}),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        },
        async () => {
            try {
                return mcpToolSuccess(await documentations.listDocumentations());
            } catch (error: unknown) {
                return mcpToolFailure(error);
            }
        },
    );

    if (enabledTools.has("read_documentation_source")) server.registerTool(
        "read_documentation_source",
        {
            title: "Read a documentation source",
            description:
                "Read the text of a source returned by search_documentation. " +
                "Use this when an excerpt needs more context or references another " +
                "file in the same documentation. Large sources are returned in " +
                "character ranges that can be continued with nextStart.",
            inputSchema: z.object({
                documentation: documentationReference,
                source: documentationSourceReference,
                start: z.number().int().min(0).optional().describe(
                    "Zero-based character position at which to start; defaults to 0.",
                ),
                maxCharacters: z.number().int().min(1)
                    .max(MCP_MAXIMUM_DOCUMENTATION_SOURCE_CHARACTERS)
                    .optional().describe(
                        "Maximum characters returned; defaults to " +
                        `${MCP_DEFAULT_DOCUMENTATION_SOURCE_CHARACTERS} and is capped at ` +
                        `${MCP_MAXIMUM_DOCUMENTATION_SOURCE_CHARACTERS}.`,
                    ),
            }),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        },
        async (input) => {
            try {
                return mcpToolSuccess(await documentations.readSource({
                    documentationReference: input.documentation,
                    sourceReference: input.source,
                    ...(input.start === undefined ? {} : { start: input.start }),
                    ...(input.maxCharacters === undefined
                        ? {}
                        : { maximumCharacters: input.maxCharacters }),
                }));
            } catch (error: unknown) {
                return mcpToolFailure(error);
            }
        },
    );

    if (enabledTools.has("search_documentation")) server.registerTool(
        "search_documentation",
        {
            title: "Search documentation",
            description:
                "Search documentation and reference material. Use this for API " +
                "references, manuals, specifications, guides, design documents, " +
                "and other explanatory material. Call list_documentations first " +
                "if you do not know which documentation to search. Returns ranked " +
                "excerpts with source attribution and surrounding context. Use " +
                "read_documentation_source when an excerpt needs more context or " +
                "points to another documentation file.",
            inputSchema: z.object({
                query,
                documentation: documentationReference,
                sources: z.array(z.string().trim().min(1)).optional().describe(
                    "Optional source identifiers; only matching sources are searched.",
                ),
                tags: z.array(z.string().trim().min(1)).optional().describe(
                    "Optional exact tags; only matching tagged sources are searched.",
                ),
                limit: resultLimit,
                ...contextFields,
                ...rerankingFields,
            }),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        },
        async (input, extra) => {
            try {
                return mcpToolSuccess(await documentations.search({
                    query: input.query,
                    documentationReference: input.documentation,
                    ...(input.sources === undefined
                        ? {}
                        : { sourceIds: input.sources }),
                    ...(input.tags === undefined ? {} : { tags: input.tags }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                    ...(input.includeContext === undefined
                        ? {}
                        : { includeContext: input.includeContext }),
                    ...(input.contextBefore === undefined
                        ? {}
                        : { contextBefore: input.contextBefore }),
                    ...(input.contextAfter === undefined
                        ? {}
                        : { contextAfter: input.contextAfter }),
                    ...(input.contextCharacters === undefined
                        ? {}
                        : { contextCharacters: input.contextCharacters }),
                    ...(input.rerank === undefined
                        ? {}
                        : { rerank: input.rerank }),
                    ...(input.rerankCandidates === undefined
                        ? {}
                        : { rerankCandidates: input.rerankCandidates }),
                }, extra.signal));
            } catch (error: unknown) {
                return mcpToolFailure(error);
            }
        },
    );

    return server;
}

function createMcpInstructions(enabledTools: ReadonlySet<string>): string {
    const instructions = [
        "Use these tools to search and inspect source code and documentation.",
        "Every tool is read-only and cannot change files, indexes, projects, " +
            "documentation, sources, or tags.",
    ];

    if (enabledTools.has("search_codebase")) {
        instructions.push(
            "search_codebase answers questions about this project's source by " +
                "meaning: describe the behavior or concept and it returns ranked " +
                "excerpts with file paths and returned line ranges. It searches the " +
                "project this server was started with.",
        );
    }

    if (enabledTools.has("search_documentation")) {
        instructions.push(
            "Use search_documentation for separately managed documentation and " +
                "reference material. If you do not know which documentation to " +
                "search, call list_documentations first. Use " +
                "read_documentation_source to read source files or follow a " +
                "documentation-relative file reference.",
        );
    }

    return instructions.join(" ");
}
