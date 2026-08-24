import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    ChunkingError,
    ParserSourceMap,
    Utf8ByteOffsetIndex,
} from "../index.js";

function expectChunkingError(
    error: unknown,
    code: ChunkingError["code"],
): boolean {
    assert.ok(error instanceof ChunkingError);
    assert.equal(error.code, code);
    return true;
}

describe("Utf8ByteOffsetIndex", () => {
    it("maps ASCII, Cyrillic, emoji, and CRLF boundaries to UTF-16", () => {
        const content = "AЖ😀\r\nB";
        const index = new Utf8ByteOffsetIndex(content);

        assert.equal(index.byteLength, 10);
        assert.equal(index.utf16Length, 7);
        assert.equal(index.utf16OffsetAtByteOffset(0), 0);
        assert.equal(index.utf16OffsetAtByteOffset(1), 1);
        assert.equal(index.utf16OffsetAtByteOffset(3), 2);
        assert.equal(index.utf16OffsetAtByteOffset(7), 4);
        assert.equal(index.utf16OffsetAtByteOffset(10), 7);
        assert.equal(index.byteOffsetAtUtf16Offset(2), 3);
        assert.equal(index.byteOffsetAtUtf16Offset(4), 7);
    });

    it("rejects offsets inside UTF-8 sequences and surrogate pairs", () => {
        const index = new Utf8ByteOffsetIndex("AЖ😀B");

        assert.throws(
            () => index.utf16OffsetAtByteOffset(2),
            (error: unknown) =>
                expectChunkingError(error, "invalid-byte-boundary"),
        );
        assert.throws(
            () => index.byteOffsetAtUtf16Offset(3),
            (error: unknown) =>
                expectChunkingError(error, "invalid-byte-boundary"),
        );
    });

    it("rejects non-integer and out-of-bounds offsets", () => {
        const index = new Utf8ByteOffsetIndex("code");

        assert.throws(
            () => index.utf16OffsetAtByteOffset(-1),
            (error: unknown) =>
                expectChunkingError(error, "invalid-byte-offset"),
        );
        assert.throws(
            () => index.byteOffsetAtUtf16Offset(1.5),
            (error: unknown) =>
                expectChunkingError(error, "invalid-byte-offset"),
        );
    });

    it("rejects unpaired source surrogates", () => {
        assert.throws(
            () => new Utf8ByteOffsetIndex("a\ud800b"),
            (error: unknown) =>
                expectChunkingError(error, "invalid-document"),
        );
        assert.throws(
            () => new Utf8ByteOffsetIndex("a\udc00b"),
            (error: unknown) =>
                expectChunkingError(error, "invalid-document"),
        );
    });
});

describe("ParserSourceMap", () => {
    it("creates canonical source ranges directly from parser byte offsets", () => {
        const sourceMap = new ParserSourceMap("AЖ😀\r\nB");

        assert.deepEqual(sourceMap.rangeFromByteOffsets(1, 7), {
            startOffset: 1,
            endOffset: 4,
            startLine: 1,
            endLine: 1,
        });
        assert.deepEqual(sourceMap.rangeFromByteOffsets(7, 10), {
            startOffset: 4,
            endOffset: 7,
            startLine: 1,
            endLine: 2,
        });
    });
});
