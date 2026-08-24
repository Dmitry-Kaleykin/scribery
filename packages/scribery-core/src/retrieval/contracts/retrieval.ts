import type { SourceRange } from "../../metadata/index.js";
import type { StorageFilterCondition } from "../../storage/index.js";

export interface RetrievalContextOptions {
    beforeChunks?: number;
    afterChunks?: number;
    maximumCharacters?: number;
}

export type RetrievalRerankingFailureMode =
    | "error"
    | "use-semantic-order";

export interface RetrievalRerankingOptions {
    candidateLimit?: number;
    failureMode?: RetrievalRerankingFailureMode;
}

export interface RetrievalRequest {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    query: string;
    filters?: readonly StorageFilterCondition[];
    limit?: number;
    rerank?: RetrievalRerankingOptions;
    context?: RetrievalContextOptions;
    signal?: AbortSignal;
}

export interface RetrievalContextChunk {
    chunkId: string;
    index: number;
    content: string;
    range: SourceRange;
    kind?: string;
}

export interface RetrievalContext {
    before: readonly RetrievalContextChunk[];
    after: readonly RetrievalContextChunk[];
}

export interface RetrievalResult {
    score: number;
    semanticScore?: number;
    rerankScore?: number;
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    documentId: string;
    sourceId?: string;
    sourceTitle?: string;
    sourceAttributes?: Readonly<Record<string, string | number | boolean>>;
    chunkId: string;
    path: string;
    language: string;
    format: string;
    content: string;
    range: SourceRange;
    kind?: string;
    context?: RetrievalContext;
}
