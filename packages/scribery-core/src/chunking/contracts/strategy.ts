import type { Chunk, ChunkingDocument, ChunkingOptions } from "./chunk.js";
import type { ChunkingStrategyId } from "../../shared/index.js";

export interface ChunkingStrategy {
    readonly id: ChunkingStrategyId;

    chunk(
        document: ChunkingDocument,
        options: ChunkingOptions,
    ): Promise<Chunk[]>;
}
