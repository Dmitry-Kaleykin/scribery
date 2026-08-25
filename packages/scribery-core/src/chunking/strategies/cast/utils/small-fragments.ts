import { throwIfChunkingAborted } from "../../../utils/throw-if-aborted.js";
import {
    DANGLING_PREFIX_MAXIMUM_SIZE,
    DANGLING_PREFIX_MAXIMUM_SIZE_RATIO,
} from "../constants/compaction.js";
import type { SourceFragment } from "../contracts/fragment.js";

export function compactSmallFragments(
    fragments: readonly SourceFragment[],
    content: string,
    maximumSize: number,
    path: string,
    signal?: AbortSignal,
): readonly SourceFragment[] {
    const compacted = [...fragments];
    const maximumSmallSize = Math.min(
        DANGLING_PREFIX_MAXIMUM_SIZE,
        Math.floor(maximumSize * DANGLING_PREFIX_MAXIMUM_SIZE_RATIO),
    );
    let index = 0;

    while (index < compacted.length) {
        throwIfChunkingAborted(signal, path);
        const fragment = compacted[index];

        if (
            fragment === undefined ||
            fragment.boundaryAffinity !== undefined ||
            fragmentSize(fragment) > maximumSmallSize
        ) {
            index += 1;
            continue;
        }

        const neighborIndex = selectNeighborIndex(
            compacted,
            index,
            fragment,
            content,
            maximumSize,
        );

        if (neighborIndex === undefined) {
            index += 1;
            continue;
        }

        const leftIndex = Math.min(index, neighborIndex);
        const rightIndex = Math.max(index, neighborIndex);
        const left = compacted[leftIndex];
        const right = compacted[rightIndex];

        if (left === undefined || right === undefined) {
            throw new Error("A cAST compaction neighbor disappeared");
        }

        compacted.splice(leftIndex, 2, {
            startOffset: left.startOffset,
            endOffset: right.endOffset,
        });
        index = Math.max(0, leftIndex - 1);
    }

    return compacted;
}

function selectNeighborIndex(
    fragments: readonly SourceFragment[],
    index: number,
    fragment: SourceFragment,
    content: string,
    maximumSize: number,
): number | undefined {
    const candidates = [index - 1, index + 1].filter((neighborIndex) => {
        const neighbor = fragments[neighborIndex];

        return neighbor !== undefined &&
            neighbor.boundaryAffinity === undefined &&
            fragmentSize(fragment) + fragmentSize(neighbor) <= maximumSize;
    });

    if (candidates.length < 2) {
        return candidates[0];
    }

    const source = content.slice(fragment.startOffset, fragment.endOffset)
        .trim();

    if (/^(?:catch|else|finally)\b/u.test(source) || /^[}\])]/u.test(source)) {
        return index - 1;
    }

    return candidates.sort((leftIndex, rightIndex) =>
        fragmentSize(fragments[rightIndex]) -
        fragmentSize(fragments[leftIndex])
    )[0];
}

function fragmentSize(fragment: SourceFragment | undefined): number {
    return fragment === undefined
        ? Number.POSITIVE_INFINITY
        : fragment.endOffset - fragment.startOffset;
}
