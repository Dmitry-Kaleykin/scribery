export interface OpenAiCompatibleEmbeddingProfile {
    /** `lm-studio` is accepted when reading profiles created before 1.1. */
    provider: "openai-compatible" | "lm-studio";
    model: string;
    dimensions: number;
    baseUrl?: string;
    maximumInputs?: number;
    embeddingSuffix?: string;
}

export interface OpenAiCompatibleQwen3RerankingProfile {
    /** `lm-studio-qwen3` is accepted when reading profiles created before 1.1. */
    provider: "openai-compatible-qwen3" | "lm-studio-qwen3";
    model: string;
    baseUrl?: string;
    instruction?: string;
}

export interface OpenAiCompatibleRerankProfile {
    provider: "openai-compatible-rerank";
    model: string;
    baseUrl?: string;
}

export type OpenAiCompatibleRerankingProfile =
    | OpenAiCompatibleQwen3RerankingProfile
    | OpenAiCompatibleRerankProfile;

/** @deprecated Use OpenAiCompatibleEmbeddingProfile. */
export type LmStudioEmbeddingProfile = OpenAiCompatibleEmbeddingProfile;
/** @deprecated Use OpenAiCompatibleQwen3RerankingProfile. */
export type LmStudioRerankingProfile = OpenAiCompatibleQwen3RerankingProfile;

export interface ProviderProfile {
    name: string;
    embedding: OpenAiCompatibleEmbeddingProfile;
    reranking?: OpenAiCompatibleRerankingProfile;
    createdAt: string;
    updatedAt: string;
}

export interface ProviderProfiles {
    schemaVersion: 1;
    updatedAt: string;
    profiles: readonly ProviderProfile[];
}

export interface ProviderProfileInput {
    name: string;
    embedding: OpenAiCompatibleEmbeddingProfile;
    reranking?: OpenAiCompatibleRerankingProfile;
}

export interface ProviderProfileDiagnostic {
    profile: string;
    embedding: {
        provider: string;
        model: string;
        dimensions: number;
    };
    reranking?: {
        provider: string;
        model: string;
        score: number;
    };
}
