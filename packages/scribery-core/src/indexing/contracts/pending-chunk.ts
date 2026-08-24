import type { EmbeddingInput } from "../../embeddings/index.js";
import type { FilterMetadata } from "../../metadata/index.js";
import type { StoredChunk } from "../../storage/index.js";

export interface PendingChunkEmbedding {
    documentId: string;
    chunk: StoredChunk;
    embeddingInput: EmbeddingInput;
    filterMetadata: FilterMetadata;
}
