import { parseArgs } from "node:util";

import {
    DocumentationCatalog,
    DocumentationService,
    documentationDatabasePath,
} from "scribery-documents";
import {
    createOpenAiCompatibleRerankingProvider,
    openAiCompatibleEmbeddingProviderFromBuild,
} from "scribery-core";
import { SqliteStorageProvider, type IndexBuildRecord } from "scribery-core";
import {
    nonNegativeInteger,
    positiveInteger,
} from "../arguments/values.js";

export async function runDocumentationSearchIfRequested(
    args: readonly string[],
): Promise<boolean> {
    if (!args.some((argument) =>
        argument === "--documentation" || argument.startsWith("--documentation=")
    )) {
        return false;
    }

    const parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
            documentation: { type: "string" },
            source: { type: "string", multiple: true },
            tag: { type: "string", multiple: true },
            "base-url": { type: "string" },
            limit: { type: "string" },
            language: { type: "string" },
            "context-before": { type: "string" },
            "context-after": { type: "string" },
            "context-characters": { type: "string" },
            "rerank-model": { type: "string" },
            "rerank-candidates": { type: "string" },
            "rerank-fallback": { type: "boolean" },
            "rerank-instruction": { type: "string" },
        },
    });
    const reference = parsed.values.documentation!;
    const query = parsed.positionals.join(" ").trim();

    if (parsed.values.language !== undefined) {
        throw new Error("--language is not yet supported with --documentation");
    }
    if (
        parsed.values["rerank-model"] === undefined &&
        hasRerankingOptions(parsed.values)
    ) {
        throw new Error("--rerank-model is required for reranking options");
    }

    const catalog = new DocumentationCatalog();
    const manifest = await catalog.resolve(reference);
    if (
        manifest.activeBuild === undefined ||
        manifest.activeBuild.configurationRevision !== manifest.configurationRevision
    ) {
        throw new Error(`Documentation ${manifest.name} must be indexed first`);
    }
    const databasePath = documentationDatabasePath(
        catalog.baseDirectory,
        manifest.documentationId,
    );
    const storage = new SqliteStorageProvider(databasePath, {
        readOnly: true,
        immutable: true,
    });
    const build = await storage.getBuild(manifest.activeBuild.indexBuildId);
    await storage.close();
    if (build === undefined || build.status !== "ready") {
        throw new Error(`Active build for ${manifest.name} is not ready`);
    }

    const provider = embeddingProviderFromBuild(build, parsed.values["base-url"]);
    const rerankingProvider = createRerankingProvider(
        parsed.values["rerank-model"],
        parsed.values["base-url"],
        parsed.values["rerank-instruction"],
    );
    const service = new DocumentationService({
        embeddingProvider: provider,
        ...(rerankingProvider === undefined ? {} : { rerankingProvider }),
    });
    const results = await service.retrieve(reference, {
        query,
        ...(parsed.values.limit === undefined
            ? {}
            : { limit: positiveInteger(parsed.values.limit, "--limit") }),
        ...(parsed.values.source === undefined && parsed.values.tag === undefined
            ? {}
            : {
                scope: {
                    ...(parsed.values.source === undefined
                        ? {}
                        : { sourceIds: parsed.values.source }),
                    ...(parsed.values.tag === undefined
                        ? {}
                        : { tags: parsed.values.tag }),
                },
            }),
        ...(hasContextOptions(parsed.values)
            ? { context: contextOptions(parsed.values) }
            : {}),
        ...(rerankingProvider === undefined
            ? {}
            : { rerank: rerankingOptions(parsed.values) }),
    });
    console.log(JSON.stringify(results, null, 2));
    return true;
}

function embeddingProviderFromBuild(
    build: IndexBuildRecord,
    baseUrl: string | undefined,
): ReturnType<typeof openAiCompatibleEmbeddingProviderFromBuild> {
    return openAiCompatibleEmbeddingProviderFromBuild(build, {
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...((process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) === undefined
            ? {}
            : { apiKey: (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) }),
    });
}

function createRerankingProvider(
    model: string | undefined,
    baseUrl: string | undefined,
    instruction: string | undefined,
): ReturnType<typeof createOpenAiCompatibleRerankingProvider> {
    return model === undefined
        ? undefined
        : createOpenAiCompatibleRerankingProvider({
            model,
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...((process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) === undefined
                ? {}
                : { apiKey: (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) }),
            ...(instruction === undefined ? {} : { instruction }),
        });
}

function contextOptions(values: {
    "context-before"?: string;
    "context-after"?: string;
    "context-characters"?: string;
}): {
    beforeChunks?: number;
    afterChunks?: number;
    maximumCharacters?: number;
} {
    return {
        ...(values["context-before"] === undefined
            ? {}
            : {
                beforeChunks: nonNegativeInteger(
                    values["context-before"],
                    "--context-before",
                ),
            }),
        ...(values["context-after"] === undefined
            ? {}
            : {
                afterChunks: nonNegativeInteger(
                    values["context-after"],
                    "--context-after",
                ),
            }),
        ...(values["context-characters"] === undefined
            ? {}
            : {
                maximumCharacters: positiveInteger(
                    values["context-characters"],
                    "--context-characters",
                ),
            }),
    };
}

function rerankingOptions(values: {
    "rerank-candidates"?: string;
    "rerank-fallback"?: boolean;
}): {
    candidateLimit?: number;
    failureMode?: "use-semantic-order";
} {
    return {
        ...(values["rerank-candidates"] === undefined
            ? {}
            : {
                candidateLimit: positiveInteger(
                    values["rerank-candidates"],
                    "--rerank-candidates",
                ),
            }),
        ...(values["rerank-fallback"] === true
            ? { failureMode: "use-semantic-order" as const }
            : {}),
    };
}

function hasContextOptions(values: {
    "context-before"?: string;
    "context-after"?: string;
    "context-characters"?: string;
}): boolean {
    return values["context-before"] !== undefined ||
        values["context-after"] !== undefined ||
        values["context-characters"] !== undefined;
}

function hasRerankingOptions(values: {
    "rerank-candidates"?: string;
    "rerank-fallback"?: boolean;
    "rerank-instruction"?: string;
}): boolean {
    return values["rerank-candidates"] !== undefined ||
        values["rerank-fallback"] === true ||
        values["rerank-instruction"] !== undefined;
}
