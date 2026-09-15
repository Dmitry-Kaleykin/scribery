import { compressionFlags, compressionFromFlags } from "../arguments/compression.js";
import { OpenAiCompatibleCompressionProvider, ProviderProfileService, presentRetrievalResults, type RetrievalDiagnostics } from "scribery-core";
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
            ...compressionFlags,
            documentation: { type: "string" },
            profile: { type: "string" },
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
    if (hasContextOptions(parsed.values)) {
        throw new Error("Neighbor expansion has been replaced; use --compression-characters and --compression-input-tokens");
    }
    const query = parsed.positionals.join(" ").trim();

    if (parsed.values.language !== undefined) {
        throw new Error("--language is not yet supported with --documentation");
    }
    const profileService = new ProviderProfileService({
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY,
    });
    const profile = parsed.values.profile === undefined ? undefined : await profileService.get(parsed.values.profile);
    const baseUrl = parsed.values["base-url"] ?? profile?.embedding.baseUrl;
    if (
        parsed.values["rerank-model"] === undefined && profile?.reranking === undefined &&
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

    const provider = embeddingProviderFromBuild(build, baseUrl);
    const rerankingProvider = parsed.values["rerank-model"] === undefined && profile?.reranking !== undefined
        ? profileService.createRerankingProvider(profile) : createRerankingProvider(
        parsed.values["rerank-model"],
        baseUrl,
        parsed.values["rerank-instruction"],
    );
    const compression = compressionFromFlags(parsed.values, profile?.compression, baseUrl);
    const service = new DocumentationService({
        compressionProvider: new OpenAiCompatibleCompressionProvider({ ...compression,
            apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY,
        }),
        compression,
        embeddingProvider: provider,
        ...(rerankingProvider === undefined ? {} : { rerankingProvider }),
    });
    let diagnostics: RetrievalDiagnostics | undefined;
    const results = await service.retrieve(reference, {
        compression,
        onDiagnostics: (value) => { diagnostics = value; },
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
        ...(rerankingProvider === undefined
            ? {}
            : { rerank: rerankingOptions(parsed.values) }),
    });
    console.log(JSON.stringify({ results: presentRetrievalResults(results), diagnostics }, null, 2));
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
