import type { SyntaxNode } from "../../../contracts/syntax-tree.js";
import { throwIfChunkingAborted } from "../../../utils/throw-if-aborted.js";
import type {
    BoundaryAffinity,
    SourceFragment,
} from "../contracts/fragment.js";

export function boundaryAffinityFor(
    node: SyntaxNode,
    startOffset: number,
    endOffset: number,
    content: string,
): BoundaryAffinity | undefined {
    if (
        content.slice(
            node.range.startOffset,
            node.range.endOffset,
        ).trim().length > 0
    ) {
        return undefined;
    }

    const extendsBackward = startOffset < node.range.startOffset;
    const extendsForward = endOffset > node.range.endOffset;

    if (extendsBackward && !extendsForward) {
        return "forward";
    }

    if (extendsForward && !extendsBackward) {
        return "backward";
    }

    return "either";
}

export function combineBoundaryAffinities(
    left: BoundaryAffinity | undefined,
    right: BoundaryAffinity | undefined,
): BoundaryAffinity | undefined {
    if (left === undefined || right === undefined) {
        return undefined;
    }

    return left === right ? left : "either";
}

export function compactBoundaryFragments(
    fragments: readonly SourceFragment[],
    maximumSize: number,
    path: string,
    signal?: AbortSignal,
): readonly SourceFragment[] {
    const compacted = [...fragments];
    let index = 0;

    while (index < compacted.length) {
        throwIfChunkingAborted(signal, path);
        const fragment = compacted[index];

        if (
            fragment === undefined ||
            fragment.boundaryAffinity === undefined
        ) {
            index += 1;
            continue;
        }

        const neighborIndex = mergeNeighborIndex(
            compacted,
            index,
            fragment.boundaryAffinity,
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
            throw new Error("A cAST boundary neighbor disappeared");
        }

        compacted.splice(leftIndex, 2, mergeFragments(left, right));
        index = Math.max(0, leftIndex - 1);
    }

    return compacted;
}

function mergeNeighborIndex(
    fragments: readonly SourceFragment[],
    index: number,
    affinity: BoundaryAffinity,
    maximumSize: number,
): number | undefined {
    const preferred = affinity === "forward"
        ? [index + 1, index - 1]
        : affinity === "backward"
            ? [index - 1, index + 1]
            : neighborIndexesBySize(fragments, index);

    return preferred.find((neighborIndex) =>
        canMergeBoundary(
            fragments[index],
            fragments[neighborIndex],
            maximumSize,
        )
    );
}

function neighborIndexesBySize(
    fragments: readonly SourceFragment[],
    index: number,
): readonly number[] {
    return [index - 1, index + 1]
        .filter((neighborIndex) => fragments[neighborIndex] !== undefined)
        .sort((leftIndex, rightIndex) =>
            fragmentSize(fragments[leftIndex]) -
            fragmentSize(fragments[rightIndex])
        );
}

function canMergeBoundary(
    boundary: SourceFragment | undefined,
    neighbor: SourceFragment | undefined,
    maximumSize: number,
): boolean {
    if (boundary === undefined || neighbor === undefined) {
        return false;
    }

    const combinedSize = fragmentSize(boundary) + fragmentSize(neighbor);

    return combinedSize <= maximumSize ||
        fragmentSize(neighbor) > maximumSize;
}

function fragmentSize(fragment: SourceFragment | undefined): number {
    return fragment === undefined
        ? Number.POSITIVE_INFINITY
        : fragment.endOffset - fragment.startOffset;
}

function mergeFragments(
    left: SourceFragment,
    right: SourceFragment,
): SourceFragment {
    if (left.endOffset !== right.startOffset) {
        throw new Error("Only contiguous cAST fragments can be compacted");
    }

    const leftIsBoundary = left.boundaryAffinity !== undefined;
    const rightIsBoundary = right.boundaryAffinity !== undefined;
    const kind = leftIsBoundary === rightIsBoundary
        ? undefined
        : leftIsBoundary
            ? right.kind
            : left.kind;
    const boundaryAffinity =
        left.boundaryAffinity === undefined ||
            right.boundaryAffinity === undefined
            ? undefined
            : combineBoundaryAffinities(
                left.boundaryAffinity,
                right.boundaryAffinity,
            );

    return {
        startOffset: left.startOffset,
        endOffset: right.endOffset,
        ...(kind === undefined ? {} : { kind }),
        ...(boundaryAffinity === undefined ? {} : { boundaryAffinity }),
    };
}
