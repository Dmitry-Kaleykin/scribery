import { SourcePositionError, SourcePositionIndex } from "../../metadata/index.js";
import type { ChunkingDocument } from "../contracts/chunk.js";
import type {
    NormalizedSyntaxTree,
    SyntaxNode,
} from "../contracts/syntax-tree.js";
import { ChunkingError } from "../errors/chunking-error.js";

interface PendingNode {
    node: SyntaxNode;
    parent: SyntaxNode | undefined;
}

export function validateNormalizedSyntaxTree(
    document: ChunkingDocument,
    tree: NormalizedSyntaxTree,
    expectedParserId: string,
): void {
    if (tree.parserId !== expectedParserId) {
        throw invalidTree("Normalized tree parser identity does not match its adapter", {
            actualParserId: tree.parserId,
            expectedParserId,
        });
    }

    const sourcePositions = new SourcePositionIndex(document.content);

    if (
        tree.root.range.startOffset !== 0 ||
        tree.root.range.endOffset !== document.content.length
    ) {
        throw invalidTree("Normalized syntax-tree root must cover the complete document", {
            startOffset: tree.root.range.startOffset,
            endOffset: tree.root.range.endOffset,
            contentLength: document.content.length,
        });
    }

    const visitedNodes = new WeakSet<object>();
    const pendingNodes: PendingNode[] = [{ node: tree.root, parent: undefined }];

    while (pendingNodes.length > 0) {
        const current = pendingNodes.pop();

        if (current === undefined) {
            break;
        }

        const { node, parent } = current;

        if (visitedNodes.has(node)) {
            throw invalidTree("Normalized syntax tree must not contain cycles");
        }

        visitedNodes.add(node);

        if (node.type.trim().length === 0) {
            throw invalidTree("Normalized syntax node type must not be empty", {
                startOffset: node.range.startOffset,
                endOffset: node.range.endOffset,
            });
        }

        try {
            sourcePositions.validateRange(node.range);
        } catch (error: unknown) {
            if (error instanceof SourcePositionError) {
                throw invalidTree(
                    "Normalized syntax node has an invalid source range",
                    { nodeType: node.type, sourcePositionCode: error.code },
                    error,
                );
            }

            throw error;
        }

        if (
            parent !== undefined &&
            (node.range.startOffset < parent.range.startOffset ||
                node.range.endOffset > parent.range.endOffset)
        ) {
            throw invalidTree("Normalized syntax node must fit within its parent", {
                nodeType: node.type,
                parentType: parent.type,
            });
        }

        let previousEndOffset = node.range.startOffset;

        for (const child of node.children) {
            if (child.range.startOffset < previousEndOffset) {
                throw invalidTree(
                    "Normalized syntax-node children must be ordered and non-overlapping",
                    { nodeType: node.type, childType: child.type },
                );
            }

            previousEndOffset = child.range.endOffset;
        }

        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            const child = node.children[index];

            if (child !== undefined) {
                pendingNodes.push({ node: child, parent: node });
            }
        }
    }
}

function invalidTree(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): ChunkingError {
    return new ChunkingError(
        "invalid-syntax-tree",
        message,
        details,
        cause,
    );
}
