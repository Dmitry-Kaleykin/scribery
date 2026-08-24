import { SourcePositionError } from "../errors/source-position-error.js";

export class SourceLineIndex {
    readonly #contentLength: number;
    readonly #lineStartOffsets: readonly number[];

    constructor(content: string) {
        this.#contentLength = content.length;
        this.#lineStartOffsets = buildLineStartOffsets(content);
    }

    get contentLength(): number {
        return this.#contentLength;
    }

    get lineCount(): number {
        return this.#lineStartOffsets.length;
    }

    lineNumberAtOffset(offset: number): number {
        if (!Number.isSafeInteger(offset)) {
            throw new SourcePositionError(
                "invalid-offset",
                "Source offset must be a safe integer",
                { field: "offset", value: offset },
            );
        }

        if (offset < 0 || offset >= this.#contentLength) {
            throw new SourcePositionError(
                "out-of-bounds",
                "Source offset must identify a code unit in the document",
                {
                    field: "offset",
                    value: offset,
                    contentLength: this.#contentLength,
                },
            );
        }

        let lowerBound = 0;
        let upperBound = this.#lineStartOffsets.length - 1;

        while (lowerBound <= upperBound) {
            const middle = Math.floor((lowerBound + upperBound) / 2);
            const lineStart = this.#lineStartOffsets[middle];

            if (lineStart === undefined) {
                throw new Error("Source line index is internally inconsistent");
            }

            if (lineStart <= offset) {
                lowerBound = middle + 1;
            } else {
                upperBound = middle - 1;
            }
        }

        return upperBound + 1;
    }
}

function buildLineStartOffsets(content: string): number[] {
    const lineStartOffsets = [0];

    for (let offset = 0; offset < content.length; offset += 1) {
        const codeUnit = content.charCodeAt(offset);

        if (codeUnit === 0x0d) {
            if (content.charCodeAt(offset + 1) === 0x0a) {
                offset += 1;
            }

            lineStartOffsets.push(offset + 1);
        } else if (codeUnit === 0x0a) {
            lineStartOffsets.push(offset + 1);
        }
    }

    return lineStartOffsets;
}
