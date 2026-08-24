import { ChunkingError } from "../errors/chunking-error.js";

export class Utf8ByteOffsetIndex {
    readonly #byteOffsets: readonly number[];
    readonly #utf16Offsets: readonly number[];

    constructor(content: string) {
        if (typeof content !== "string") {
            throw new ChunkingError(
                "invalid-document",
                "Parser source content must be a JavaScript string",
                { actualType: typeof content },
            );
        }

        const byteOffsets = [0];
        const utf16Offsets = [0];
        let byteOffset = 0;
        let utf16Offset = 0;

        while (utf16Offset < content.length) {
            const firstCodeUnit = content.charCodeAt(utf16Offset);
            let codePoint = firstCodeUnit;
            let utf16Width = 1;

            if (isHighSurrogate(firstCodeUnit)) {
                const secondCodeUnit = content.charCodeAt(utf16Offset + 1);

                if (!isLowSurrogate(secondCodeUnit)) {
                    throw invalidSurrogateError(utf16Offset);
                }

                codePoint =
                    0x10000 +
                    ((firstCodeUnit - 0xd800) << 10) +
                    (secondCodeUnit - 0xdc00);
                utf16Width = 2;
            } else if (isLowSurrogate(firstCodeUnit)) {
                throw invalidSurrogateError(utf16Offset);
            }

            byteOffset += utf8Width(codePoint);
            utf16Offset += utf16Width;
            byteOffsets.push(byteOffset);
            utf16Offsets.push(utf16Offset);
        }

        this.#byteOffsets = byteOffsets;
        this.#utf16Offsets = utf16Offsets;
    }

    get byteLength(): number {
        return this.#byteOffsets[this.#byteOffsets.length - 1] ?? 0;
    }

    get utf16Length(): number {
        return this.#utf16Offsets[this.#utf16Offsets.length - 1] ?? 0;
    }

    utf16OffsetAtByteOffset(byteOffset: number): number {
        validateOffset("byteOffset", byteOffset, this.byteLength);
        const index = findExactOffset(this.#byteOffsets, byteOffset);

        if (index === undefined) {
            throw new ChunkingError(
                "invalid-byte-boundary",
                "Parser byte offset must identify a complete UTF-8 character boundary",
                { byteOffset, byteLength: this.byteLength },
            );
        }

        const utf16Offset = this.#utf16Offsets[index];

        if (utf16Offset === undefined) {
            throw new Error("UTF-8 byte-offset index is internally inconsistent");
        }

        return utf16Offset;
    }

    byteOffsetAtUtf16Offset(utf16Offset: number): number {
        validateOffset("utf16Offset", utf16Offset, this.utf16Length);
        const index = findExactOffset(this.#utf16Offsets, utf16Offset);

        if (index === undefined) {
            throw new ChunkingError(
                "invalid-byte-boundary",
                "UTF-16 offset must not split a Unicode surrogate pair",
                { utf16Offset, utf16Length: this.utf16Length },
            );
        }

        const byteOffset = this.#byteOffsets[index];

        if (byteOffset === undefined) {
            throw new Error("UTF-8 byte-offset index is internally inconsistent");
        }

        return byteOffset;
    }
}

function findExactOffset(
    offsets: readonly number[],
    target: number,
): number | undefined {
    let lowerBound = 0;
    let upperBound = offsets.length - 1;

    while (lowerBound <= upperBound) {
        const middle = Math.floor((lowerBound + upperBound) / 2);
        const value = offsets[middle];

        if (value === target) {
            return middle;
        }

        if (value === undefined || value > target) {
            upperBound = middle - 1;
        } else {
            lowerBound = middle + 1;
        }
    }

    return undefined;
}

function validateOffset(field: string, value: number, maximum: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new ChunkingError(
            "invalid-byte-offset",
            `${field} must be a safe integer within the indexed source`,
            { field, value, maximum },
        );
    }
}

function utf8Width(codePoint: number): number {
    if (codePoint <= 0x7f) {
        return 1;
    }

    if (codePoint <= 0x7ff) {
        return 2;
    }

    if (codePoint <= 0xffff) {
        return 3;
    }

    return 4;
}

function isHighSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function invalidSurrogateError(offset: number): ChunkingError {
    return new ChunkingError(
        "invalid-document",
        "Parser source content contains an unpaired Unicode surrogate",
        { utf16Offset: offset },
    );
}
