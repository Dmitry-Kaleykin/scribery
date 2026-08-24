import { OpenAiCompatibleEmbeddingProvider } from "../../embeddings/index.js";
import {
    OpenAiCompatibleQwen3RerankingProvider,
    OpenAiCompatibleRerankProvider,
    type RerankingProvider,
} from "../../reranking/index.js";
import type { IndexBuildRecord } from "../../storage/index.js";

export interface OpenAiCompatibleRetrievalProviderOptions {
    baseUrl?: string;
    apiKey?: string | undefined;
    fetch?: typeof globalThis.fetch;
}

export interface OpenAiCompatibleRerankingProviderOptions
    extends OpenAiCompatibleRetrievalProviderOptions {
    model: string;
    protocol?: "completions" | "rerank";
    instruction?: string;
}

export function openAiCompatibleEmbeddingProviderFromBuild(
    build: IndexBuildRecord,
    options: OpenAiCompatibleRetrievalProviderOptions = {},
): OpenAiCompatibleEmbeddingProvider {
    return new OpenAiCompatibleEmbeddingProvider({
        model: build.modelIdentity.model,
        dimensions: build.modelIdentity.dimensions,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(build.modelIdentity.revision === undefined
            ? {}
            : { revision: build.modelIdentity.revision }),
        ...(build.modelIdentity.documentPrefix === undefined
            ? {}
            : { documentPrefix: build.modelIdentity.documentPrefix }),
        ...(build.modelIdentity.queryPrefix === undefined
            ? {}
            : { queryPrefix: build.modelIdentity.queryPrefix }),
        ...(build.modelIdentity.embeddingSuffix === undefined
            ? {}
            : { embeddingSuffix: build.modelIdentity.embeddingSuffix }),
    });
}

export function createOpenAiCompatibleRerankingProvider(
    options: OpenAiCompatibleRerankingProviderOptions | undefined,
): RerankingProvider | undefined {
    if (options === undefined) return undefined;

    if (options.protocol === "rerank") {
        return new OpenAiCompatibleRerankProvider({
            model: options.model,
            ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        });
    }

    return new OpenAiCompatibleQwen3RerankingProvider({
        model: options.model,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.instruction === undefined
            ? {}
            : { instruction: options.instruction }),
    });
}

/** @deprecated Use OpenAiCompatibleRetrievalProviderOptions. */
export type LmStudioRetrievalProviderOptions = OpenAiCompatibleRetrievalProviderOptions;

/** @deprecated Use OpenAiCompatibleRerankingProviderOptions. */
export type LmStudioRerankingProviderOptions = OpenAiCompatibleRerankingProviderOptions;

/** @deprecated Use openAiCompatibleEmbeddingProviderFromBuild. */
export const lmStudioEmbeddingProviderFromBuild = openAiCompatibleEmbeddingProviderFromBuild;

/** @deprecated Use createOpenAiCompatibleRerankingProvider. */
export const createLmStudioRerankingProvider = createOpenAiCompatibleRerankingProvider;
