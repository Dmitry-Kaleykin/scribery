import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";

import { ProviderProfileService } from "scribery-core";
import type { ScriberyMcpServerOptions } from "./contracts/server.js";
import { createScriberyMcpServer } from "./server/create-server.js";
import { parseMcpToolAllowlist } from "./tools/tool-allowlist.js";

export async function runScriberyMcpServer(
    args: readonly string[],
    version: string,
): Promise<void> {
    const parsed = parseArgs({
        args,
        options: {
            project: { type: "string" },
            profile: { type: "string" },
            "base-url": { type: "string" },
            "api-key": { type: "string" },
            "rerank-model": { type: "string" },
            "rerank-instruction": { type: "string" },
            tools: { type: "string", multiple: true },
            help: { type: "boolean" },
            version: { type: "boolean" },
        },
    });

    if (parsed.values.help === true) {
        printMcpUsage();
        return;
    }
    if (parsed.values.version === true) {
        console.log(version);
        return;
    }

    if (
        parsed.values.profile !== undefined &&
        (
            parsed.values["base-url"] !== undefined ||
            parsed.values["rerank-model"] !== undefined ||
            parsed.values["rerank-instruction"] !== undefined
        )
    ) {
        throw new Error(
            "--profile cannot be combined with retrieval provider options",
        );
    }
    const profile = parsed.values.profile === undefined
        ? undefined
        : await new ProviderProfileService().get(parsed.values.profile);
    const toolAllowlist = parseMcpToolAllowlist(parsed.values.tools);
    const baseUrl = profile?.embedding.baseUrl ?? parsed.values["base-url"];
    const apiKey = resolveMcpApiKey(parsed.values["api-key"]);
    const rerankingModel = profile?.reranking?.model ??
        parsed.values["rerank-model"];
    const rerankingProtocol = profile?.reranking?.provider === "openai-compatible-rerank"
        ? "rerank" as const
        : "completions" as const;
    const rerankingInstruction = (profile?.reranking !== undefined &&
            "instruction" in profile.reranking
        ? profile.reranking.instruction
        : undefined) ??
        parsed.values["rerank-instruction"];
    const options: ScriberyMcpServerOptions = {
        version,
        ...(parsed.values.project === undefined
            ? {}
            : { defaultProjectReference: requiredText(parsed.values.project, "--project") }),
        ...(baseUrl === undefined
            ? {}
            : { baseUrl: requiredText(baseUrl, "--base-url") }),
        ...(apiKey === undefined
            ? {}
            : { apiKey }),
        ...(rerankingModel === undefined
            ? {}
            : {
                rerankingModel: requiredText(
                    rerankingModel,
                    "--rerank-model",
                ),
            }),
        ...(rerankingModel === undefined
            ? {}
            : { rerankingProtocol }),
        ...(rerankingInstruction === undefined
            ? {}
            : {
                rerankingInstruction: requiredText(
                    rerankingInstruction,
                    "--rerank-instruction",
                ),
            }),
        ...(toolAllowlist === undefined
            ? {}
            : { toolAllowlist }),
    };

    const server = createScriberyMcpServer(options);
    await server.connect(new StdioServerTransport());
}

function printMcpUsage(): void {
    console.log(`Scribery MCP server (read-only stdio)

Usage:
    scribery-mcp [--project <identifier-or-root>]
        [--profile <name>]
        [--base-url http://127.0.0.1:1234/v1] [--api-key <key>]
        [--rerank-model <id>]
        [--rerank-instruction <text>] [--tools <name[,name...]>]

Available tools:
    list_projects, search_codebase, inspect_project_chunks,
    list_documentations, search_documentation, read_documentation_source

Legacy --tools name:
    retrieval maps to search_codebase

The normal server mode reserves stdout exclusively for MCP JSON-RPC.
--api-key overrides OPENAI_COMPATIBLE_API_KEY and the legacy
LM_STUDIO_API_KEY fallback.`);
}

function requiredText(value: string, option: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`${option} must not be empty`);
    }
    return trimmed;
}

export function resolveMcpApiKey(
    explicitApiKey: string | undefined,
    environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
    if (explicitApiKey !== undefined) {
        return requiredText(explicitApiKey, "--api-key");
    }
    if (environment.OPENAI_COMPATIBLE_API_KEY !== undefined) {
        return requiredText(
            environment.OPENAI_COMPATIBLE_API_KEY,
            "OPENAI_COMPATIBLE_API_KEY",
        );
    }
    if (environment.LM_STUDIO_API_KEY !== undefined) {
        return requiredText(environment.LM_STUDIO_API_KEY, "LM_STUDIO_API_KEY");
    }
    return undefined;
}
