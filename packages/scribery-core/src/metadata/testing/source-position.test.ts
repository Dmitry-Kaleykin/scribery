import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    SourcePositionError,
    SourcePositionIndex,
} from "../index.js";
import type { SourceRange } from "../index.js";

function expectSourcePositionError(
    error: unknown,
    code: SourcePositionError["code"],
): boolean {
    assert.ok(error instanceof SourcePositionError);
    assert.equal(error.code, code);
    return true;
}

describe("SourcePositionIndex", () => {
    it("creates a one-line range with UTF-16 offsets", () => {
        const content = "const answer = 42;";
        const index = new SourcePositionIndex(content);
        const sourceSlice = index.createSlice(6, 12);

        assert.equal(index.contentLength, content.length);
        assert.equal(index.lineCount, 1);
        assert.deepEqual(sourceSlice, {
            range: {
                startOffset: 6,
                endOffset: 12,
                startLine: 1,
                endLine: 1,
            },
            content: "answer",
        });
    });

    it("indexes LF lines and multiline ranges", () => {
        const content = "alpha\nbeta\ngamma";
        const index = new SourcePositionIndex(content);

        assert.equal(index.lineCount, 3);
        assert.equal(index.lineNumberAtOffset(0), 1);
        assert.equal(index.lineNumberAtOffset(5), 1);
        assert.equal(index.lineNumberAtOffset(6), 2);
        assert.equal(index.lineNumberAtOffset(content.length - 1), 3);
        assert.deepEqual(index.createRange(2, 13), {
            startOffset: 2,
            endOffset: 13,
            startLine: 1,
            endLine: 3,
        });
    });

    it("treats CRLF as one line break without normalizing content", () => {
        const content = "alpha\r\nbeta\r\ngamma";
        const index = new SourcePositionIndex(content);
        const betaStart = content.indexOf("beta");
        const betaEnd = betaStart + "beta".length;
        const sourceSlice = index.createSlice(betaStart, betaEnd);

        assert.equal(index.lineCount, 3);
        assert.equal(index.lineNumberAtOffset(content.indexOf("\r")), 1);
        assert.equal(index.lineNumberAtOffset(content.indexOf("\n")), 1);
        assert.deepEqual(sourceSlice.range, {
            startOffset: betaStart,
            endOffset: betaEnd,
            startLine: 2,
            endLine: 2,
        });
        assert.equal(sourceSlice.content, "beta");
        assert.equal(index.slice(index.createRange(0, content.length)), content);
    });

    it("supports lone carriage returns deterministically", () => {
        const content = "first\rsecond";
        const index = new SourcePositionIndex(content);

        assert.equal(index.lineCount, 2);
        assert.equal(index.lineNumberAtOffset(content.indexOf("\r")), 1);
        assert.equal(index.lineNumberAtOffset(content.indexOf("second")), 2);
    });

    it("counts a final empty logical line but ranges only occupied code units", () => {
        const content = "first\nsecond\n";
        const index = new SourcePositionIndex(content);
        const fullRange = index.createRange(0, content.length);

        assert.equal(index.lineCount, 3);
        assert.equal(fullRange.endLine, 2);
        assert.equal(index.slice(fullRange), content);
    });

    it("uses the final occupied line when the document has no trailing newline", () => {
        const content = "first\nsecond";
        const index = new SourcePositionIndex(content);
        const range = index.createRange(content.indexOf("second"), content.length);

        assert.deepEqual(range, {
            startOffset: 6,
            endOffset: 12,
            startLine: 2,
            endLine: 2,
        });
    });

    it("accepts complete surrogate pairs and rejects split boundaries", () => {
        const content = "a😀b";
        const index = new SourcePositionIndex(content);

        assert.equal(content.length, 4);
        assert.deepEqual(index.createSlice(1, 3), {
            range: {
                startOffset: 1,
                endOffset: 3,
                startLine: 1,
                endLine: 1,
            },
            content: "😀",
        });
        assert.throws(
            () => index.createRange(2, 3),
            (error: unknown) =>
                expectSourcePositionError(error, "split-surrogate-pair"),
        );
        assert.throws(
            () => index.createRange(1, 2),
            (error: unknown) =>
                expectSourcePositionError(error, "split-surrogate-pair"),
        );
    });

    it("rejects non-integer, out-of-bounds, empty, and reversed ranges", () => {
        const index = new SourcePositionIndex("content");

        assert.throws(
            () => index.createRange(0.5, 2),
            (error: unknown) =>
                expectSourcePositionError(error, "invalid-offset"),
        );
        assert.throws(
            () => index.createRange(-1, 2),
            (error: unknown) =>
                expectSourcePositionError(error, "out-of-bounds"),
        );
        assert.throws(
            () => index.createRange(0, 8),
            (error: unknown) =>
                expectSourcePositionError(error, "out-of-bounds"),
        );
        assert.throws(
            () => index.createRange(2, 2),
            (error: unknown) =>
                expectSourcePositionError(error, "empty-range"),
        );
        assert.throws(
            () => index.createRange(5, 2),
            (error: unknown) =>
                expectSourcePositionError(error, "reversed-range"),
        );
    });

    it("validates externally constructed line numbers before slicing", () => {
        const index = new SourcePositionIndex("first\nsecond");
        const invalidRange: SourceRange = {
            startOffset: 6,
            endOffset: 12,
            startLine: 1,
            endLine: 2,
        };

        assert.throws(
            () => index.slice(invalidRange),
            (error: unknown) =>
                expectSourcePositionError(error, "line-number-mismatch"),
        );
    });

    it("rejects invalid external line numbers", () => {
        const index = new SourcePositionIndex("content");

        assert.throws(
            () =>
                index.validateRange({
                    startOffset: 0,
                    endOffset: 1,
                    startLine: 0,
                    endLine: 1,
                }),
            (error: unknown) =>
                expectSourcePositionError(error, "invalid-line-number"),
        );
    });

    it("represents an empty document without permitting an empty chunk", () => {
        const index = new SourcePositionIndex("");

        assert.equal(index.contentLength, 0);
        assert.equal(index.lineCount, 1);
        assert.throws(
            () => index.createRange(0, 0),
            (error: unknown) =>
                expectSourcePositionError(error, "empty-range"),
        );
        assert.throws(
            () => index.lineNumberAtOffset(0),
            (error: unknown) =>
                expectSourcePositionError(error, "out-of-bounds"),
        );
    });

    it("rejects non-string content at the runtime boundary", () => {
        assert.throws(
            () => new SourcePositionIndex(42 as unknown as string),
            (error: unknown) =>
                expectSourcePositionError(error, "invalid-content"),
        );
    });
});
