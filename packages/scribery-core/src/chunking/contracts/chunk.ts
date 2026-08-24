import type { SourceRange } from "../../metadata/index.js";
import type { ChunkingStrategyId } from "../../shared/index.js";

export interface ChunkingDocument {
    path: string;
    content: string;
    language: string;
    format?: string;
}

export interface Chunk {
    content: string;
    range: SourceRange;
    strategy: ChunkingStrategyId;
    kind?: string;
    searchable?: boolean;
}

export type ChunkSizeUnit = "utf16-code-units";

export interface ChunkingOptions {
    maximumSize: number;
    sizeUnit: ChunkSizeUnit;
    signal?: AbortSignal;
}
