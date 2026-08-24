import type { Node as TreeSitterNode } from "@vscode/tree-sitter-wasm";

import { SourcePositionIndex } from "../../../metadata/index.js";
import type {
    NormalizedSyntaxTree,
    SyntaxNode,
} from "../../contracts/syntax-tree.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";

interface NativeNodeFrame {
    node: TreeSitterNode;
    expanded: boolean;
}

export function normalizeTreeSitterSyntaxTree(
    rootNode: TreeSitterNode,
    content: string,
    path: string,
    parserId: string,
    signal?: AbortSignal,
): NormalizedSyntaxTree {
    const sourcePositions = new SourcePositionIndex(content);
    const childrenByNode = new Map<
        TreeSitterNode,
        readonly TreeSitterNode[]
    >();
    const normalizedByNode = new Map<TreeSitterNode, SyntaxNode>();
    const pending: NativeNodeFrame[] = [
        { node: rootNode, expanded: false },
    ];

    while (pending.length > 0) {
        throwIfChunkingAborted(signal, path);

        const frame = pending.pop();

        if (frame === undefined) {
            break;
        }

        if (!frame.expanded) {
            const children = collectNonEmptyNamedChildren(frame.node);
            childrenByNode.set(frame.node, children);
            pending.push({ node: frame.node, expanded: true });

            for (let index = children.length - 1; index >= 0; index -= 1) {
                const child = children[index];

                if (child !== undefined) {
                    pending.push({ node: child, expanded: false });
                }
            }

            continue;
        }

        const children = childrenByNode.get(frame.node) ?? [];
        const normalizedChildren = children.map((child) => {
            const normalizedChild = normalizedByNode.get(child);

            if (normalizedChild === undefined) {
                throw new Error("A Tree-sitter AST child was not normalized");
            }

            return normalizedChild;
        });
        const startOffset = frame.node === rootNode
            ? 0
            : frame.node.startIndex;
        const endOffset = frame.node === rootNode
            ? content.length
            : frame.node.endIndex;

        normalizedByNode.set(frame.node, {
            type: frame.node.type,
            range: sourcePositions.createRange(startOffset, endOffset),
            children: normalizedChildren,
        });
    }

    const root = normalizedByNode.get(rootNode);

    if (root === undefined) {
        throw new Error("The Tree-sitter AST root was not normalized");
    }

    return { parserId, root };
}

function collectNonEmptyNamedChildren(
    node: TreeSitterNode,
): readonly TreeSitterNode[] {
    return node.namedChildren.filter(
        (child): child is TreeSitterNode =>
            child !== null && child.endIndex > child.startIndex,
    );
}
