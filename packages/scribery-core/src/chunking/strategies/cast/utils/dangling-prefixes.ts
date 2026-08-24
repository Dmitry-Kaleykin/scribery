import { throwIfChunkingAborted } from "../../../utils/throw-if-aborted.js";
import {
    DANGLING_PREFIX_ENDINGS,
    DANGLING_PREFIX_MAXIMUM_SIZE,
    DANGLING_PREFIX_MAXIMUM_SIZE_RATIO,
} from "../constants/compaction.js";
import type { SourceFragment } from "../contracts/fragment.js";

export function compactDanglingPrefixes(
    fragments: readonly SourceFragment[],
    content: string,
    maximumSize: number,
    path: string,
    signal?: AbortSignal,
): readonly SourceFragment[] {
    const compacted = [...fragments];

    for (let index = compacted.length - 2; index >= 0; index -= 1) {
        throwIfChunkingAborted(signal, path);
        const prefix = compacted[index];
        const continuation = compacted[index + 1];

        if (
            prefix === undefined ||
            continuation === undefined ||
            !isDanglingPrefix(prefix, content, maximumSize) ||
            !canMerge(prefix, continuation, maximumSize)
        ) {
            continue;
        }

        compacted.splice(index, 2, {
            startOffset: prefix.startOffset,
            endOffset: continuation.endOffset,
        });
    }

    return compacted;
}

export function isDanglingPrefix(
    fragment: SourceFragment,
    content: string,
    maximumSize: number,
): boolean {
    const maximumPrefixSize = Math.min(
        DANGLING_PREFIX_MAXIMUM_SIZE,
        Math.floor(maximumSize * DANGLING_PREFIX_MAXIMUM_SIZE_RATIO),
    );

    if (
        fragment.boundaryAffinity !== undefined ||
        fragment.endOffset - fragment.startOffset > maximumPrefixSize
    ) {
        return false;
    }

    const trimmed = content.slice(
        fragment.startOffset,
        fragment.endOffset,
    ).trimEnd();

    return trimmed.length > 0 &&
        DANGLING_PREFIX_ENDINGS.some((ending) => trimmed.endsWith(ending));
}

function canMerge(
    prefix: SourceFragment,
    continuation: SourceFragment,
    maximumSize: number,
): boolean {
    return prefix.endOffset === continuation.startOffset &&
        continuation.boundaryAffinity === undefined &&
        continuation.endOffset - prefix.startOffset <= maximumSize;
}
