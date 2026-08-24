import type {
    ChildNode as PostCssChildNode,
    Root as PostCssRoot,
} from "postcss";

import { SourcePositionIndex } from "../../../metadata/index.js";
import type {
    NormalizedSyntaxTree,
    SyntaxNode,
} from "../../contracts/syntax-tree.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";

type PostCssNode = PostCssRoot | PostCssChildNode;

interface PostCssNodeFrame {
    node: PostCssNode;
    expanded: boolean;
}

export function normalizePostCssSyntaxTree(
    root: PostCssRoot,
    content: string,
    path: string,
    parserId: string,
    signal?: AbortSignal,
): NormalizedSyntaxTree {
    const sourcePositions = new SourcePositionIndex(content);
    const childrenByNode = new Map<
        PostCssNode,
        readonly PostCssChildNode[]
    >();
    const normalizedByNode = new Map<PostCssNode, SyntaxNode>();
    const pending: PostCssNodeFrame[] = [
        { node: root, expanded: false },
    ];

    while (pending.length > 0) {
        throwIfChunkingAborted(signal, path);

        const frame = pending.pop();

        if (frame === undefined) {
            break;
        }

        if (!frame.expanded) {
            const children = collectChildren(frame.node);
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
            const normalized = normalizedByNode.get(child);

            if (normalized === undefined) {
                throw new Error("A PostCSS AST child was not normalized");
            }

            return normalized;
        });
        const range = frame.node === root
            ? sourcePositions.createRange(0, content.length)
            : sourcePositions.createRange(
                requiredOffset(frame.node, "start"),
                requiredOffset(frame.node, "end"),
            );

        normalizedByNode.set(frame.node, {
            type: syntaxNodeType(frame.node),
            range,
            children: normalizedChildren,
        });
    }

    const normalizedRoot = normalizedByNode.get(root);

    if (normalizedRoot === undefined) {
        throw new Error("The PostCSS AST root was not normalized");
    }

    return { parserId, root: normalizedRoot };
}

function collectChildren(node: PostCssNode): readonly PostCssChildNode[] {
    if (!("nodes" in node) || node.nodes === undefined) {
        return [];
    }

    return node.nodes.filter(
        (child) =>
            child.source?.start?.offset !== undefined &&
            child.source.end?.offset !== undefined &&
            child.source.end.offset > child.source.start.offset,
    );
}

function requiredOffset(
    node: PostCssNode,
    boundary: "start" | "end",
): number {
    const offset = node.source?.[boundary]?.offset;

    if (offset === undefined) {
        throw new Error(`A PostCSS AST node has no ${boundary} offset`);
    }

    return offset;
}

function syntaxNodeType(node: PostCssNode): string {
    if (node.type === "root") {
        return "stylesheet";
    }

    if (node.type === "atrule") {
        return `at_rule:${node.name}`;
    }

    if (node.type === "decl") {
        return "declaration";
    }

    return node.type;
}
