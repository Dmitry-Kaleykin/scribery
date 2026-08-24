import type { SourceRange } from "../contracts/source-position.js";
import type { SourceLineIndex } from "./line-index.js";
import { validateSourceOffsets } from "./validate-range.js";

export function createSourceRange(
    content: string,
    lineIndex: SourceLineIndex,
    startOffset: number,
    endOffset: number,
): SourceRange {
    validateSourceOffsets(content, startOffset, endOffset);

    return {
        startOffset,
        endOffset,
        startLine: lineIndex.lineNumberAtOffset(startOffset),
        endLine: lineIndex.lineNumberAtOffset(endOffset - 1),
    };
}
