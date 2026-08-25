import { throwIfChunkingAborted } from "../../../utils/throw-if-aborted.js";
import {
    DANGLING_PREFIX_ENDINGS,
    DANGLING_PREFIX_KEYWORDS,
    DANGLING_PREFIX_MAXIMUM_SIZE,
    DANGLING_PREFIX_MAXIMUM_SIZE_RATIO,
    STRUCTURAL_PREFIX_MAXIMUM_SIZE_RATIO,
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
            !isDanglingPrefix(
                prefix,
                content,
                maximumSize,
                continuation,
            ) ||
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
    continuation?: SourceFragment,
): boolean {
    const ordinaryMaximumPrefixSize = Math.min(
        DANGLING_PREFIX_MAXIMUM_SIZE,
        Math.floor(maximumSize * DANGLING_PREFIX_MAXIMUM_SIZE_RATIO),
    );

    if (fragment.boundaryAffinity !== undefined) {
        return false;
    }

    const trimmed = content.slice(
        fragment.startOffset,
        fragment.endOffset,
    ).trimEnd();

    if (trimmed.length === 0) {
        return false;
    }

    const opensStructuralBody = continuation !== undefined &&
        startsWithOpeningBrace(continuation, content) &&
        looksLikeBlockHeader(trimmed) &&
        !trimmed.endsWith(";") &&
        !trimmed.endsWith("}");
    const maximumPrefixSize = opensStructuralBody
        ? Math.min(
            DANGLING_PREFIX_MAXIMUM_SIZE,
            Math.floor(maximumSize * STRUCTURAL_PREFIX_MAXIMUM_SIZE_RATIO),
        )
        : ordinaryMaximumPrefixSize;

    if (fragment.endOffset - fragment.startOffset > maximumPrefixSize) {
        return false;
    }

    if (DANGLING_PREFIX_ENDINGS.some((ending) => trimmed.endsWith(ending))) {
        return true;
    }

    if (DANGLING_PREFIX_KEYWORDS.some((keyword) => endsWithKeyword(
        trimmed,
        keyword,
    ))) {
        return true;
    }

    return opensStructuralBody;
}

function looksLikeBlockHeader(content: string): boolean {
    if (content.endsWith(")")) {
        return true;
    }

    if (DANGLING_PREFIX_KEYWORDS.some((keyword) => endsWithKeyword(
        content,
        keyword,
    ))) {
        return true;
    }

    return /(?:^|[\s;{}])(?:class|enum|interface|module|namespace)\s+[^;{}]+$/u
        .test(content) ||
        /\)\s*:\s*[^;{}=]+$/u.test(content);
}

function endsWithKeyword(content: string, keyword: string): boolean {
    const startOffset = content.length - keyword.length;

    if (
        startOffset < 0 ||
        content.slice(startOffset) !== keyword
    ) {
        return false;
    }

    const precedingCharacter = content[startOffset - 1];

    return precedingCharacter === undefined ||
        !/[\p{ID_Continue}$]/u.test(precedingCharacter);
}

function startsWithOpeningBrace(
    fragment: SourceFragment,
    content: string,
): boolean {
    return content.slice(fragment.startOffset, fragment.endOffset)
        .trimStart()
        .startsWith("{");
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
