import { SourcePositionIndex } from "../../metadata/index.js";
import { CHUNKING_STRATEGY } from "../../shared/index.js";
import type {
    Chunk,
    ChunkingDocument,
    ChunkingOptions,
} from "../contracts/chunk.js";
import type { ChunkingStrategy } from "../contracts/strategy.js";
import { ChunkingError } from "../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../utils/throw-if-aborted.js";

export interface SlidingWindowChunkingStrategyOptions {
    overlapSize?: number;
}

export class SlidingWindowChunkingStrategy implements ChunkingStrategy {
    readonly id = CHUNKING_STRATEGY.SLIDING_WINDOW;
    readonly #overlapSize: number;

    constructor(options: SlidingWindowChunkingStrategyOptions = {}) {
        this.#overlapSize = options.overlapSize ?? 200;

        if (!Number.isSafeInteger(this.#overlapSize) || this.#overlapSize < 0) {
            throw new ChunkingError(
                "invalid-options",
                "Sliding-window overlap must be a non-negative safe integer",
                { overlapSize: this.#overlapSize },
            );
        }
    }

    async chunk(
        document: ChunkingDocument,
        options: ChunkingOptions,
    ): Promise<Chunk[]> {
        validateOptions(document.path, options, this.#overlapSize);
        throwIfChunkingAborted(options.signal, document.path);

        if (document.content.length === 0) {
            return [];
        }

        const positions = new SourcePositionIndex(document.content);
        const chunks: Chunk[] = [];
        let startOffset = 0;

        while (startOffset < document.content.length) {
            throwIfChunkingAborted(options.signal, document.path);
            const maximumEnd = Math.min(
                document.content.length,
                startOffset + options.maximumSize,
            );
            const preferredEndOffset = maximumEnd === document.content.length
                ? maximumEnd
                : preferredEnd(document.content, startOffset, maximumEnd);
            const endOffset = preferredEndOffset > startOffset
                ? preferredEndOffset
                : validBoundaryAtOrAfter(document.content, maximumEnd);
            const slice = positions.createSlice(startOffset, endOffset);
            chunks.push({
                content: slice.content,
                range: slice.range,
                strategy: this.id,
                kind: "text-window",
            });

            if (endOffset === document.content.length) {
                break;
            }

            startOffset = validBoundaryAtOrAfter(
                document.content,
                Math.max(startOffset + 1, endOffset - this.#overlapSize),
            );
        }

        return chunks;
    }
}

function preferredEnd(content: string, startOffset: number, maximumEnd: number): number {
    const minimumEnd = startOffset + Math.floor((maximumEnd - startOffset) / 2);

    for (const delimiter of ["\n\n", "\n", " "]) {
        const found = content.lastIndexOf(delimiter, maximumEnd - 1);

        if (found >= minimumEnd) {
            return validBoundaryAtOrBefore(content, found + delimiter.length);
        }
    }

    return validBoundaryAtOrBefore(content, maximumEnd);
}

function validBoundaryAtOrBefore(content: string, offset: number): number {
    return isInsideSurrogatePair(content, offset) ? offset - 1 : offset;
}

function validBoundaryAtOrAfter(content: string, offset: number): number {
    return isInsideSurrogatePair(content, offset) ? offset + 1 : offset;
}

function isInsideSurrogatePair(content: string, offset: number): boolean {
    const previous = content.charCodeAt(offset - 1);
    const next = content.charCodeAt(offset);
    return previous >= 0xd800 && previous <= 0xdbff &&
        next >= 0xdc00 && next <= 0xdfff;
}

function validateOptions(
    path: string,
    options: ChunkingOptions,
    overlapSize: number,
): void {
    if (
        !Number.isSafeInteger(options.maximumSize) ||
        options.maximumSize < 1 ||
        overlapSize >= options.maximumSize ||
        options.sizeUnit !== "utf16-code-units"
    ) {
        throw new ChunkingError(
            "invalid-options",
            `Sliding-window options are invalid for ${path}`,
            {
                maximumSize: options.maximumSize,
                overlapSize,
                sizeUnit: options.sizeUnit,
            },
        );
    }
}
