import {
    diagnoseEmbeddingProvider,
    OpenAiCompatibleEmbeddingProvider,
    type OpenAiCompatibleEmbeddingProviderOptions,
} from "../embeddings/index.js";
import {
    OpenAiCompatibleQwen3RerankingProvider,
    OpenAiCompatibleRerankProvider,
} from "../reranking/index.js";
import type {
    OpenAiCompatibleEmbeddingProfile,
    ProviderProfile,
    ProviderProfileInput,
} from "./contracts/provider-profile.js";
import {
    normalizeProviderProfileName,
    ProviderProfileCatalog,
} from "./managed/provider-profile-catalog.js";
import { managedProviderProfilesPath } from "./managed/paths.js";
import { OpenAiCompatibleDiscoveryService } from "./providers/lm-studio/discovery-service.js";

export interface ProviderProfileServiceOptions {
    profilesPath?: string;
    apiKey?: string | undefined;
    fetch?: typeof globalThis.fetch;
}

export class ProviderProfileService {
    readonly #catalog: ProviderProfileCatalog;
    readonly #apiKey: string | undefined;
    readonly #fetch: typeof globalThis.fetch | undefined;

    constructor(options: ProviderProfileServiceOptions = {}) {
        this.#catalog = new ProviderProfileCatalog(
            options.profilesPath ?? managedProviderProfilesPath(),
        );
        this.#apiKey = options.apiKey;
        this.#fetch = options.fetch;
    }

    async list(): Promise<readonly ProviderProfile[]> {
        return (await this.#catalog.read()).profiles;
    }

    async get(name: string): Promise<ProviderProfile> {
        const normalized = normalizeProviderProfileName(name);
        const profile = (await this.#catalog.read()).profiles.find(
            ({ name: candidate }) => candidate === normalized,
        );
        if (profile === undefined) {
            throw new Error(`Provider profile ${normalized} was not found`);
        }
        return profile;
    }

    async set(input: ProviderProfileInput): Promise<ProviderProfile> {
        const catalog = await this.#catalog.set(input);
        return catalog.profiles.find(({ name }) =>
            name === normalizeProviderProfileName(input.name)
        )!;
    }

    async remove(name: string): Promise<Readonly<Record<string, unknown>>> {
        const normalized = normalizeProviderProfileName(name);
        const catalog = await this.#catalog.remove(normalized);
        return {
            removed: normalized,
            profileCount: catalog.profiles.length,
        };
    }

    async rename(currentName: string, nextName: string): Promise<ProviderProfile> {
        const next = normalizeProviderProfileName(nextName);
        const catalog = await this.#catalog.rename(currentName, next);
        return catalog.profiles.find(({ name }) => name === next)!;
    }

    createEmbeddingProvider(profile: ProviderProfile | OpenAiCompatibleEmbeddingProfile) {
        const embedding = "embedding" in profile
            ? profile.embedding
            : profile;
        return new OpenAiCompatibleEmbeddingProvider({
            model: embedding.model,
            dimensions: embedding.dimensions,
            ...(embedding.baseUrl === undefined
                ? {}
                : { baseUrl: embedding.baseUrl }),
            ...(embedding.maximumInputs === undefined
                ? {}
                : { maximumInputs: embedding.maximumInputs }),
            ...(embedding.embeddingSuffix === undefined
                ? {}
                : { embeddingSuffix: embedding.embeddingSuffix }),
            ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
            ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        } satisfies OpenAiCompatibleEmbeddingProviderOptions);
    }

    createRerankingProvider(profile: ProviderProfile) {
        if (profile.reranking === undefined) return undefined;
        if (profile.reranking.provider === "openai-compatible-rerank") {
            return new OpenAiCompatibleRerankProvider({
                model: profile.reranking.model,
                ...(profile.reranking.baseUrl === undefined
                    ? {}
                    : { baseUrl: profile.reranking.baseUrl }),
                ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
                ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
            });
        }
        return new OpenAiCompatibleQwen3RerankingProvider({
            model: profile.reranking.model,
            ...(profile.reranking.baseUrl === undefined
                ? {}
                : { baseUrl: profile.reranking.baseUrl }),
            ...(profile.reranking.instruction === undefined
                ? {}
                : { instruction: profile.reranking.instruction }),
            ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
            ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        });
    }

    async diagnose(name: string) {
        const profile = await this.get(name);
        const embeddingDiagnostic = await diagnoseEmbeddingProvider(
            this.createEmbeddingProvider(profile),
        );
        const embedding = {
            ...embeddingDiagnostic,
            provider: "openai-compatible",
        };
        const rerankingProvider = this.createRerankingProvider(profile);
        if (rerankingProvider === undefined) {
            return { profile: profile.name, embedding };
        }
        const [reranking] = await rerankingProvider.rerank({
            query: "Where is authentication configured?",
            candidates: [{
                id: "provider-diagnostic",
                content: "Authentication is configured in the security module.",
            }],
        });
        if (reranking === undefined) {
            throw new Error("Reranking provider diagnostic returned no score");
        }
        return {
            profile: profile.name,
            embedding,
            reranking: {
                provider: profile.reranking!.provider,
                model: rerankingProvider.identity.model,
                score: reranking.score,
            },
        };
    }

    listProviderModels(baseUrl?: string, signal?: AbortSignal) {
        return this.#discovery(baseUrl).listModels(signal);
    }

    inspectEmbeddingModel(
        model: string,
        baseUrl?: string,
        embeddingSuffix?: string,
        signal?: AbortSignal,
    ) {
        return this.#discovery(baseUrl).inspectEmbeddingModel(
            model,
            embeddingSuffix,
            signal,
        );
    }

    /** @deprecated Use listProviderModels. */
    listLmStudioModels(baseUrl?: string, signal?: AbortSignal) {
        return this.listProviderModels(baseUrl, signal);
    }

    /** @deprecated Use inspectEmbeddingModel. */
    inspectLmStudioEmbeddingModel(
        model: string,
        baseUrl?: string,
        embeddingSuffix?: string,
        signal?: AbortSignal,
    ) {
        return this.inspectEmbeddingModel(model, baseUrl, embeddingSuffix, signal);
    }

    #discovery(baseUrl?: string): OpenAiCompatibleDiscoveryService {
        return new OpenAiCompatibleDiscoveryService({
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
            ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        });
    }
}
