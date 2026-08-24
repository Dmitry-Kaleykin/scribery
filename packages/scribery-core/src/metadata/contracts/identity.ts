import type { SourceRange } from "./source-position.js";

export interface EmbeddingModelIdentity {
    provider: string;
    model: string;
    dimensions: number;
    metric: "cosine" | "dot-product" | "euclidean";
    revision?: string;
    documentPrefix?: string;
    queryPrefix?: string;
    embeddingSuffix?: string;
}

export interface ChunkIdentityInput {
    fileRevisionId: string;
    chunkingIdentity: string;
    range: SourceRange;
    contentHash: string;
}
