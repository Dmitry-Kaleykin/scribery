import { presentRetrievalResults } from "scribery-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import {
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
    "Describe the behavior or concept to locate; include known identifiers or " +
    "domain terms when available. Example: 'failed webhook retries, sendWebhookAttempt'.",
);
const resultLimit = z.number().int().min(1).max(100).optional().describe(
    `Maximum returned matches; defaults to ${MCP_DEFAULT_RESULT_LIMIT}.`,
);
const codebaseResultLimit = z.number().int().min(1).max(100).optional().describe(
    `Maximum candidate chunks to retrieve; defaults to ${MCP_CODEBASE_RESULT_LIMIT}. Selected passages from the same file may be grouped.`,
);
const contextFields = {
    compress: z.boolean().optional().describe("Select query-relevant passages; defaults to the server setting (enabled)."),
    includeContext: z.boolean().optional().describe(
        "Deprecated alias for compress.",
    ),
    contextCharacters: z.number().int().min(1).max(100_000).optional().describe(
        "Maximum extracted characters per file; defaults to 12000.",
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
        input: { query: string; limit?: number; compress?: boolean },
        signal: AbortSignal,
    ) => {
        const limit = input.limit ?? MCP_CODEBASE_RESULT_LIMIT;

        try {
            const result = await projects.search({
                query: input.query,
                limit,
                ...(input.compress === undefined ? {} : { compress: input.compress }),
            }, signal);
            const presented = presentRetrievalResults(result.results);
            return mcpToolSuccess(
                { ...result, results: presented, resultCount: presented.length, matchedChunkCount: result.resultCount },
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
                    "Find implementations related to a behavior or concept in this " +
                    "project's indexed source. Use for questions such as 'where are " +
                    "upload size limits enforced?' Include known identifiers or " +
                    "domain terms to narrow the search. Returns ranked source " +
                    "excerpts with file paths and line ranges. Use text search for " +
                    "exact occurrences and filenames. Recent edits may not yet be indexed.",
                inputSchema: z.object({
                    query: codebaseQuery,
                    limit: codebaseResultLimit,
                    compress: z.boolean().optional().describe("Return selected verbatim source passages (enabled by default unless configured otherwise). Set false to return original matched chunks."),
                }),
                annotations: READ_ONLY_TOOL_ANNOTATIONS,
            },
            async (input, extra) =>
                executeCodebaseSearch({
                    query: input.query,
                    ...(input.compress === undefined ? {} : { compress: input.compress }),
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
                    ...(input.compress === undefined ? {} : { compress: input.compress }),
                    ...(input.includeContext === undefined
                        ? {}
                        : { includeContext: input.includeContext }),
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
                "candidate excerpts with file paths and returned line ranges. " +
                "It searches this project's selected index; recent edits may not " +
                "yet be indexed. Use text search for exact occurrences and filenames.",
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
