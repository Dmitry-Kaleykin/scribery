import type { EmbeddingModelIdentity } from "../../metadata/index.js";

export type EmbeddingMode = "document" | "query";

export interface EmbeddingInput {
    id: string;
    text: string;
    mode: EmbeddingMode;
}

export interface EmbeddingResult {
    id: string;
    vector: Float32Array;
}

export interface EmbeddingProviderOptions {
    signal?: AbortSignal;
}

export interface EmbeddingProvider {
    readonly identity: EmbeddingModelIdentity;
    readonly maximumInputs: number;
    readonly maximumCharacters: number;

    embed(
        inputs: readonly EmbeddingInput[],
        options?: EmbeddingProviderOptions,
    ): Promise<readonly EmbeddingResult[]>;
}

export interface EmbeddingServiceOptions {
    maximumInputsPerBatch?: number;
    maximumCharactersPerBatch?: number;
    onProgress?: (progress: EmbeddingProgress) => void;
    signal?: AbortSignal;
}

export interface EmbeddingBatch {
    results: readonly EmbeddingResult[];
    progress: EmbeddingProgress;
}

export interface EmbeddingProgress {
    completedInputs: number;
    totalInputs: number;
    completedBatches: number;
    totalBatches: number;
}

export interface DocumentEmbeddingContent {
    path: string;
    language: string;
    content: string;
    kind?: string;
}
