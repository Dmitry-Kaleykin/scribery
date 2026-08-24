import type {
    SourceRange,
    SourceSlice,
} from "../contracts/source-position.js";
import { SourcePositionError } from "../errors/source-position-error.js";
import { createSourceRange } from "./create-range.js";
import { SourceLineIndex } from "./line-index.js";
import { validateSourceRange } from "./validate-range.js";

export class SourcePositionIndex {
    readonly #content: string;
    readonly #lineIndex: SourceLineIndex;

    constructor(content: string) {
        if (typeof content !== "string") {
            throw new SourcePositionError(
                "invalid-content",
                "Source-position content must be a JavaScript string",
                { actualType: typeof content },
            );
        }

        this.#content = content;
        this.#lineIndex = new SourceLineIndex(content);
    }

    get contentLength(): number {
        return this.#content.length;
    }

    get lineCount(): number {
        return this.#lineIndex.lineCount;
    }

    lineNumberAtOffset(offset: number): number {
        return this.#lineIndex.lineNumberAtOffset(offset);
    }

    createRange(startOffset: number, endOffset: number): SourceRange {
        return createSourceRange(
            this.#content,
            this.#lineIndex,
            startOffset,
            endOffset,
        );
    }

    createSlice(startOffset: number, endOffset: number): SourceSlice {
        const range = this.createRange(startOffset, endOffset);

        return {
            range,
            content: this.#content.slice(startOffset, endOffset),
        };
    }

    validateRange(range: SourceRange): void {
        validateSourceRange(this.#content, this.#lineIndex, range);
    }

    slice(range: SourceRange): string {
        this.validateRange(range);
        return this.#content.slice(range.startOffset, range.endOffset);
    }
}
