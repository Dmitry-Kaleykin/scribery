import type { SourceRange } from "../contracts/source-position.js";
import { SourcePositionError } from "../errors/source-position-error.js";
import type { SourceLineIndex } from "./line-index.js";

export function validateSourceOffsets(
    content: string,
    startOffset: number,
    endOffset: number,
): void {
    validateOffset("startOffset", startOffset);
    validateOffset("endOffset", endOffset);

    if (
        startOffset < 0 ||
        startOffset > content.length ||
        endOffset < 0 ||
        endOffset > content.length
    ) {
        throw new SourcePositionError(
            "out-of-bounds",
            "Source range must fit within the decoded document",
            { startOffset, endOffset, contentLength: content.length },
        );
    }

    if (startOffset === endOffset) {
        throw new SourcePositionError(
            "empty-range",
            "Source range must contain at least one UTF-16 code unit",
            { startOffset, endOffset },
        );
    }

    if (startOffset > endOffset) {
        throw new SourcePositionError(
            "reversed-range",
            "Source range start must precede its end",
            { startOffset, endOffset },
        );
    }

    validateSurrogateBoundary(content, "startOffset", startOffset);
    validateSurrogateBoundary(content, "endOffset", endOffset);
}

export function validateSourceRange(
    content: string,
    lineIndex: SourceLineIndex,
    range: SourceRange,
): void {
    validateSourceOffsets(content, range.startOffset, range.endOffset);
    validateLineNumber("startLine", range.startLine);
    validateLineNumber("endLine", range.endLine);

    const expectedStartLine = lineIndex.lineNumberAtOffset(range.startOffset);
    const expectedEndLine = lineIndex.lineNumberAtOffset(range.endOffset - 1);

    if (range.startLine !== expectedStartLine) {
        throw new SourcePositionError(
            "line-number-mismatch",
            "Source range start line does not match its start offset",
            {
                field: "startLine",
                actual: range.startLine,
                expected: expectedStartLine,
            },
        );
    }

    if (range.endLine !== expectedEndLine) {
        throw new SourcePositionError(
            "line-number-mismatch",
            "Source range end line does not match its exclusive end offset",
            {
                field: "endLine",
                actual: range.endLine,
                expected: expectedEndLine,
            },
        );
    }
}

function validateOffset(field: string, offset: number): void {
    if (!Number.isSafeInteger(offset)) {
        throw new SourcePositionError(
            "invalid-offset",
            `${field} must be a safe integer`,
            { field, value: offset },
        );
    }
}

function validateLineNumber(field: string, lineNumber: number): void {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
        throw new SourcePositionError(
            "invalid-line-number",
            `${field} must be a positive safe integer`,
            { field, value: lineNumber },
        );
    }
}

function validateSurrogateBoundary(
    content: string,
    field: "startOffset" | "endOffset",
    offset: number,
): void {
    if (offset === 0 || offset === content.length) {
        return;
    }

    const precedingCodeUnit = content.charCodeAt(offset - 1);
    const followingCodeUnit = content.charCodeAt(offset);

    if (
        isHighSurrogate(precedingCodeUnit) &&
        isLowSurrogate(followingCodeUnit)
    ) {
        throw new SourcePositionError(
            "split-surrogate-pair",
            `${field} must not split a Unicode surrogate pair`,
            { field, value: offset },
        );
    }
}

function isHighSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
