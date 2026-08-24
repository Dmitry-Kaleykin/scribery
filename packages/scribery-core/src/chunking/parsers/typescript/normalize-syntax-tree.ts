import ts from "@typescript/typescript6";

import { SourcePositionIndex } from "../../../metadata/index.js";
import type {
    NormalizedSyntaxTree,
    SyntaxNode,
} from "../../contracts/syntax-tree.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";
import { isPunctuationNode } from "./utils/is-punctuation-node.js";
import { syntaxKindName } from "./utils/syntax-kind-name.js";

interface NativeNodeFrame {
    node: ts.Node;
    expanded: boolean;
}

export function normalizeTypeScriptSyntaxTree(
    sourceFile: ts.SourceFile,
    content: string,
    parserId: string,
    signal?: AbortSignal,
): NormalizedSyntaxTree {
    const sourcePositions = new SourcePositionIndex(content);
    const childrenByNode = new Map<ts.Node, readonly ts.Node[]>();
    const normalizedByNode = new Map<ts.Node, SyntaxNode>();
    const pending: NativeNodeFrame[] = [
        { node: sourceFile, expanded: false },
    ];

    while (pending.length > 0) {
        throwIfChunkingAborted(signal, sourceFile.fileName);

        const frame = pending.pop();

        if (frame === undefined) {
            break;
        }

        if (!frame.expanded) {
            const children = collectNonEmptyChildren(frame.node);
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
                throw new Error("A TypeScript AST child was not normalized");
            }

            return normalizedChild;
        });
        const startOffset = frame.node === sourceFile ? 0 : frame.node.pos;
        const endOffset = frame.node === sourceFile
            ? content.length
            : frame.node.end;

        normalizedByNode.set(frame.node, {
            type: syntaxKindName(frame.node.kind),
            range: sourcePositions.createRange(startOffset, endOffset),
            children: normalizedChildren,
        });
    }

    const root = normalizedByNode.get(sourceFile);

    if (root === undefined) {
        throw new Error("The TypeScript AST root was not normalized");
    }

    return { parserId, root };
}

function collectNonEmptyChildren(node: ts.Node): readonly ts.Node[] {
    const children: ts.Node[] = [];

    ts.forEachChild(node, (child) => {
        if (child.end > child.pos && !isPunctuationNode(child)) {
            children.push(child);
        }
    });

    return children;
}
