export interface OpenAiCompatibleModelSummary {
    id: string;
    object?: string;
    ownedBy?: string;
}

export interface OpenAiCompatibleEmbeddingInspection {
    provider: "openai-compatible";
    model: string;
    dimensions: number;
}

export interface OpenAiCompatibleConnectionOptions {
    baseUrl?: string;
    apiKey?: string | undefined;
    fetch?: typeof globalThis.fetch;
}

/** @deprecated Use OpenAiCompatibleModelSummary. */
export type LmStudioModelSummary = OpenAiCompatibleModelSummary;
/** @deprecated Use OpenAiCompatibleEmbeddingInspection. */
export type LmStudioEmbeddingInspection = OpenAiCompatibleEmbeddingInspection;
/** @deprecated Use OpenAiCompatibleConnectionOptions. */
export type LmStudioConnectionOptions = OpenAiCompatibleConnectionOptions;
