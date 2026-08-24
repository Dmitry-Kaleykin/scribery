import { SourcePositionIndex } from "../../metadata/index.js";
import type { SourceRange } from "../../metadata/index.js";
import { Utf8ByteOffsetIndex } from "./utf8-byte-offset-index.js";

export class ParserSourceMap {
    readonly #byteOffsets: Utf8ByteOffsetIndex;
    readonly #sourcePositions: SourcePositionIndex;

    constructor(content: string) {
        this.#byteOffsets = new Utf8ByteOffsetIndex(content);
        this.#sourcePositions = new SourcePositionIndex(content);
    }

    get byteLength(): number {
        return this.#byteOffsets.byteLength;
    }

    get utf16Length(): number {
        return this.#byteOffsets.utf16Length;
    }

    utf16OffsetAtByteOffset(byteOffset: number): number {
        return this.#byteOffsets.utf16OffsetAtByteOffset(byteOffset);
    }

    byteOffsetAtUtf16Offset(utf16Offset: number): number {
        return this.#byteOffsets.byteOffsetAtUtf16Offset(utf16Offset);
    }

    rangeFromByteOffsets(
        startByteOffset: number,
        endByteOffset: number,
    ): SourceRange {
        const startOffset = this.utf16OffsetAtByteOffset(startByteOffset);
        const endOffset = this.utf16OffsetAtByteOffset(endByteOffset);

        return this.#sourcePositions.createRange(startOffset, endOffset);
    }
}
