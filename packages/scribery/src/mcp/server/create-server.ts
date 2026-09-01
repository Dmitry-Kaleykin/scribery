import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import {
    MCP_DEFAULT_DOCUMENTATION_SOURCE_CHARACTERS,
    MCP_DEFAULT_RESULT_LIMIT,
    MCP_MAXIMUM_DOCUMENTATION_SOURCE_CHARACTERS,
    MCP_MAXIMUM_CHUNK_PAGE_SIZE,
    MCP_SERVER_NAME,
    READ_ONLY_TOOL_ANNOTATIONS,
} from "../constants/defaults.js";
import type { ScriberyMcpServerOptions } from "../contracts/server.js";
import { formatProjectSearchResult } from "../results/project-search-result.js";
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
    "Describe the implementation, behavior, or concept to find.",
);
const resultLimit = z.number().int().min(1).max(100).optional().describe(
    `Maximum returned matches; defaults to ${MCP_DEFAULT_RESULT_LIMIT}.`,
);
const codebaseResultLimit = z.number().int().min(1).max(100).optional().describe(
    "Maximum number of code excerpts to return.",
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
    const executeProjectSearch = async (
        input: Parameters<McpProjectService["search"]>[0],
        signal: AbortSignal,
    ) => {
        try {
            const result = await projects.search(input, signal);
            return mcpToolSuccess(result, formatProjectSearchResult(result));
        } catch (error: unknown) {
            return mcpToolFailure(error);
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
                    "Search this project's source code and repository-local " +
                    "documentation by meaning. " +
                    "Use this first to locate implementations, understand behavior, " +
                    "or find related code across files—even when a symbol or filename " +
                    "is known. Call with only query; the project and current build are " +
                    "already selected. Returns ranked excerpts with file paths, line " +
                    "ranges, and surrounding context.",
                inputSchema: z.object({
                    query: codebaseQuery,
                    limit: codebaseResultLimit,
                }),
                annotations: READ_ONLY_TOOL_ANNOTATIONS,
            },
            async (input, extra) =>
                executeProjectSearch({
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
            "Use search_codebase first for questions about source-code behavior, " +
                "architecture, or implementation in the current project. It needs " +
                "only a query.",
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
