import type {
    Node as MarkdownNode,
    Parent as MarkdownParent,
    Root,
} from "mdast";

import { SourcePositionIndex } from "../../../metadata/index.js";
import type {
    NormalizedSyntaxTree,
    SyntaxNode,
} from "../../contracts/syntax-tree.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";

interface MarkdownNodeFrame {
    node: MarkdownNode;
    expanded: boolean;
}

interface MarkdownSection {
    depth: number;
    startOffset: number;
    endOffset: number;
    children: MarkdownSectionItem[];
}

type MarkdownSectionItem = MarkdownSection | SyntaxNode;

export function normalizeMarkdownSyntaxTree(
    root: Root,
    content: string,
    path: string,
    parserId: string,
    signal?: AbortSignal,
): NormalizedSyntaxTree {
    const sourcePositions = new SourcePositionIndex(content);
    const normalizedByNode = normalizeMarkdownNodes(
        root,
        content,
        path,
        sourcePositions,
        signal,
    );
    const rootItems: MarkdownSectionItem[] = [];
    const openSections: MarkdownSection[] = [];

    for (const node of root.children) {
        throwIfChunkingAborted(signal, path);
        const normalized = normalizedByNode.get(node);

        if (normalized === undefined) {
            throw new Error("A Markdown syntax child was not normalized");
        }

        if (node.type !== "heading") {
            const parent = openSections[openSections.length - 1];
            (parent?.children ?? rootItems).push(normalized);
            continue;
        }

        const headingStartOffset = normalized.range.startOffset;

        while (
            openSections.length > 0 &&
            openSections[openSections.length - 1]!.depth >= node.depth
        ) {
            openSections.pop()!.endOffset = headingStartOffset;
        }

        const section: MarkdownSection = {
            depth: node.depth,
            startOffset: headingStartOffset,
            endOffset: content.length,
            children: [],
        };
        const parent = openSections[openSections.length - 1];
        (parent?.children ?? rootItems).push(section);
        openSections.push(section);
    }

    const children = rootItems.map((item) =>
        normalizeSectionItem(item, sourcePositions)
    );

    return {
        parserId,
        root: {
            type: "markdown:document",
            range: sourcePositions.createRange(0, content.length),
            children,
        },
    };
}

function normalizeMarkdownNodes(
    root: Root,
    content: string,
    path: string,
    sourcePositions: SourcePositionIndex,
    signal?: AbortSignal,
): ReadonlyMap<MarkdownNode, SyntaxNode> {
    const normalizedByNode = new Map<MarkdownNode, SyntaxNode>();
    const pending: MarkdownNodeFrame[] = root.children
        .map((node) => ({ node, expanded: false }))
        .reverse();

    while (pending.length > 0) {
        throwIfChunkingAborted(signal, path);
        const frame = pending.pop();

        if (frame === undefined) {
            break;
        }

        if (!frame.expanded) {
            pending.push({ node: frame.node, expanded: true });

            if (isMarkdownParent(frame.node)) {
                for (
                    let index = frame.node.children.length - 1;
                    index >= 0;
                    index -= 1
                ) {
                    const child = frame.node.children[index];

                    if (child !== undefined) {
                        pending.push({ node: child, expanded: false });
                    }
                }
            }

            continue;
        }

        const { startOffset, endOffset } = offsetsOf(frame.node);
        const normalizedChildren = isMarkdownParent(frame.node)
            ? frame.node.children.map((child) => {
                const normalized = normalizedByNode.get(child);

                if (normalized === undefined) {
                    throw new Error("A Markdown syntax child was not normalized");
                }

                return normalized;
            })
            : createLineChildren(
                frame.node.type,
                startOffset,
                endOffset,
                content,
                sourcePositions,
            );

        normalizedByNode.set(frame.node, {
            type: `markdown:${frame.node.type}`,
            range: sourcePositions.createRange(startOffset, endOffset),
            children: normalizedChildren,
        });
    }

    return normalizedByNode;
}

function normalizeSectionItem(
    item: MarkdownSectionItem,
    sourcePositions: SourcePositionIndex,
): SyntaxNode {
    if (!isMarkdownSection(item)) {
        return item;
    }

    return {
        type: `markdown:section:${item.depth}`,
        range: sourcePositions.createRange(item.startOffset, item.endOffset),
        children: item.children.map((child) =>
            normalizeSectionItem(child, sourcePositions)
        ),
    };
}

function createLineChildren(
    nodeType: string,
    startOffset: number,
    endOffset: number,
    content: string,
    sourcePositions: SourcePositionIndex,
): readonly SyntaxNode[] {
    const children: SyntaxNode[] = [];
    let lineStartOffset = startOffset;
    let offset = startOffset;

    while (offset < endOffset) {
        const codeUnit = content.charCodeAt(offset);

        if (codeUnit !== 0x0a && codeUnit !== 0x0d) {
            offset += 1;
            continue;
        }

        const lineEndOffset = codeUnit === 0x0d &&
                content.charCodeAt(offset + 1) === 0x0a
            ? offset + 2
            : offset + 1;
        children.push({
            type: `markdown:${nodeType}:line`,
            range: sourcePositions.createRange(lineStartOffset, lineEndOffset),
            children: [],
        });
        lineStartOffset = lineEndOffset;
        offset = lineEndOffset;
    }

    if (lineStartOffset < endOffset) {
        children.push({
            type: `markdown:${nodeType}:line`,
            range: sourcePositions.createRange(lineStartOffset, endOffset),
            children: [],
        });
    }

    return children.length > 1 ? children : [];
}

function offsetsOf(node: MarkdownNode): {
    startOffset: number;
    endOffset: number;
} {
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;

    if (startOffset === undefined || endOffset === undefined) {
        throw new Error(`Markdown node ${node.type} has no source offsets`);
    }

    return { startOffset, endOffset };
}

function isMarkdownParent(node: MarkdownNode): node is MarkdownParent {
    return "children" in node && Array.isArray(node.children);
}

function isMarkdownSection(
    item: MarkdownSectionItem,
): item is MarkdownSection {
    return "depth" in item;
}
