import type { CompressionOptions, CompressionDiagnostic, CompressionExcerpt, RetrievalDiagnostics } from "../../compression/index.js";
import type {
    ChunkSemanticContext,
    SourceRange,
} from "../../metadata/index.js";
import type { StorageFilterCondition } from "../../storage/index.js";

/** @deprecated Neighbor expansion was replaced by CompressionOptions. */
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
    /** @deprecated Rejected with a migration error; use compression. */
    context?: RetrievalContextOptions;
    compression?: CompressionOptions;
    onDiagnostics?: (diagnostics: RetrievalDiagnostics) => void;
    signal?: AbortSignal;
}

export interface RetrievalContextChunk {
    chunkId: string;
    index: number;
    content: string;
    range: SourceRange;
    kind?: string;
    semanticContext?: ChunkSemanticContext;
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
    semanticContext?: ChunkSemanticContext;
    context?: RetrievalContext;
    compression?: { diagnostic: CompressionDiagnostic; excerpts: readonly CompressionExcerpt[] };
}
