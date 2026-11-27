import { presentRetrievalResults } from "scribery-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import {
    MCP_CODEBASE_RESULT_LIMIT,
    MCP_SERVER_NAME,
    READ_ONLY_TOOL_ANNOTATIONS,
} from "../constants/defaults.js";
import type { ScriberyMcpServerOptions } from "../contracts/server.js";
import {
    formatProjectSearchResult,
    projectSearchFailure,
} from "../results/project-search-result.js";
import { mcpToolFailure, mcpToolSuccess } from "../results/tool-result.js";
import { McpProjectManagementService } from "../services/project-management-service.js";
import { McpProjectService } from "../services/project-service.js";

export function createScriberyMcpServer(options: ScriberyMcpServerOptions): McpServer {
    const server = new McpServer(
        { name: MCP_SERVER_NAME, version: options.version },
        { instructions:
            "Search indexed source in the configured project. Read actual files with your codebase tools. " +
            "list_targets shows the shared active selection; switch_target changes it. " +
            "index_codebase indexes the current working tree using saved settings, creates or updates " +
            "a target (current Git branch by default), and activates it after success. " +
            "Targets label indexes; these tools never check out Git branches."
        },
    );
    const projects = new McpProjectService(options);
    const management = new McpProjectManagementService(options);

    server.registerTool("search_codebase", {
        title: "Search the codebase",
        description:
            "Find implementations related to a behavior or concept in this " +
            "project's indexed source. Use for questions such as 'where are " +
            "upload size limits enforced?' Include known identifiers or " +
            "domain terms to narrow the search. Returns ranked source " +
            "excerpts with file paths and line ranges. Use text search for " +
            "exact occurrences and filenames. Recent edits may not yet be indexed.",
        inputSchema: z.object({
            query: z.string().trim().min(1).describe(
                "Describe the behavior or concept to locate; include known identifiers or " +
                "domain terms when available. Example: 'failed webhook retries, sendWebhookAttempt'.",
            ),
            limit: z.number().int().min(1).max(100).optional().describe(
                `Maximum candidate chunks to retrieve; defaults to ${MCP_CODEBASE_RESULT_LIMIT}. Selected passages from the same file may be grouped.`,
            ),
            compress: z.boolean().optional().describe(
                "Return selected verbatim source passages (enabled by default unless configured otherwise). Set false to return original matched chunks.",
            ),
        }),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async (input, extra) => {
        const limit = input.limit ?? MCP_CODEBASE_RESULT_LIMIT;
        try {
            const result = await projects.search({
                query: input.query,
                limit,
                ...(input.compress === undefined ? {} : { compress: input.compress }),
            }, extra.signal);
            const presented = presentRetrievalResults(result.results);
            return mcpToolSuccess(
                { ...result, results: presented, resultCount: presented.length, matchedChunkCount: result.resultCount },
                formatProjectSearchResult(result, input.query, limit),
            );
        } catch (error: unknown) {
            return projectSearchFailure(error);
        }
    });

    server.registerTool("list_targets", {
        title: "List targets",
        description: "List this project's indexed targets and shared active selection.",
        inputSchema: z.object({}),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async () => {
        try {
            return mcpToolSuccess(await management.listTargets());
        } catch (error: unknown) {
            return mcpToolFailure(error);
        }
    });

    server.registerTool("switch_target", {
        title: "Switch target",
        description: "Activate an existing index target for subsequent searches across clients. Does not change the Git branch.",
        inputSchema: z.object({
            target: z.string().trim().min(1).describe("Existing target name from list_targets."),
        }),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (input, extra) => {
        try {
            return mcpToolSuccess(await management.switchTarget(input.target, extra.signal));
        } catch (error: unknown) {
            return mcpToolFailure(error);
        }
    });

    server.registerTool("index_codebase", {
        title: "Index the codebase",
        description:
            "Index this project's current working tree using saved settings. Create or update " +
            "the target and activate it after success. Applies saved build retention. Does not check out branches.",
        inputSchema: z.object({
            target: z.string().trim().min(1).optional().describe(
                "Destination target, new or existing. Defaults to the current Git branch name; required without a branch.",
            ),
        }),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (input, extra) => {
        const token = extra._meta?.progressToken;
        let progress = 0;
        let lastNotification = 0;
        try {
            return mcpToolSuccess(await management.indexCodebase(input.target, extra.signal, (event) => {
                if (token === undefined || (Date.now() - lastNotification < 500 && event.type === "indexing-progress")) return;
                lastNotification = Date.now();
                void extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                        progressToken: token,
                        progress: ++progress,
                        message: event.type === "indexing-progress" ? event.progress.phase : event.type,
                    },
                }).catch(() => { /* A disconnected progress listener must not fail indexing. */ });
            }));
        } catch (error: unknown) {
            return mcpToolFailure(error);
        }
    });

    return server;
}
