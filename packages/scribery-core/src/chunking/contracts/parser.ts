import type { ChunkingDocument } from "./chunk.js";
import type { NormalizedSyntaxTree } from "./syntax-tree.js";

export interface ParserTarget {
    language: string;
    format?: string;
}

export interface ParserOptions {
    signal?: AbortSignal;
}

export interface CodeParserAdapter {
    readonly id: string;
    readonly targets: readonly ParserTarget[];

    parse(
        document: ChunkingDocument,
        options?: ParserOptions,
    ): Promise<NormalizedSyntaxTree>;
}
