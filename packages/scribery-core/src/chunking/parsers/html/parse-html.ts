import {
    parse,
    type DefaultTreeAdapterTypes,
    type ParserError,
} from "parse5";

import { SourcePositionIndex } from "../../../metadata/index.js";
import type {
    NormalizedSyntaxTree,
    SyntaxNode,
} from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";
import { IGNORED_HTML_PARSE_ERROR_CODES } from "./constants/parser.js";

interface HtmlRootNode {
    kind: "root";
    type: string;
    children: readonly DefaultTreeAdapterTypes.ChildNode[];
}

interface NativeNodeFrame {
    node: HtmlRootNode | DefaultTreeAdapterTypes.ChildNode;
    expanded: boolean;
}

interface HtmlSyntaxTreeOptions {
    signal?: AbortSignal;
    ignoredErrorCodes?: ReadonlySet<string>;
    recoverFromParseErrors?: boolean;
}

export function parseHtmlSyntaxTree(
    content: string,
    path: string,
    parserId: string,
    rootType: string,
    options: HtmlSyntaxTreeOptions = {},
): NormalizedSyntaxTree {
    throwIfChunkingAborted(options.signal, path);

    const errors: ParserError[] = [];
    const ignoredErrorCodes = options.ignoredErrorCodes ??
        IGNORED_HTML_PARSE_ERROR_CODES;
    const document = parse(content, {
        sourceCodeLocationInfo: true,
        onParseError: (error) => {
            if (
                options.recoverFromParseErrors !== true &&
                !ignoredErrorCodes.has(error.code)
            ) {
                errors.push(error);
            }
        },
    });

    throwIfChunkingAborted(options.signal, path);

    if (errors.length > 0) {
        throw new ChunkingError(
            "parser-failure",
            `Parser ${parserId} found invalid syntax in ${path}`,
            {
                path,
                parserId,
                diagnostics: errors.map((error) => ({
                    code: error.code,
                    startOffset: error.startOffset,
                    endOffset: error.endOffset,
                })),
            },
        );
    }

    const root: HtmlRootNode = {
        kind: "root",
        type: rootType,
        children: collectLocatedChildren(document.childNodes),
    };

    return normalizeHtmlTree(
        root,
        content,
        path,
        parserId,
        options.recoverFromParseErrors === true,
        options.signal,
    );
}

function normalizeHtmlTree(
    rootNode: HtmlRootNode,
    content: string,
    path: string,
    parserId: string,
    recoverFromParseErrors: boolean,
    signal?: AbortSignal,
): NormalizedSyntaxTree {
    const sourcePositions = new SourcePositionIndex(content);
    const childrenByNode = new Map<
        HtmlRootNode | DefaultTreeAdapterTypes.ChildNode,
        readonly DefaultTreeAdapterTypes.ChildNode[]
    >();
    const normalizedByNode = new Map<
        HtmlRootNode | DefaultTreeAdapterTypes.ChildNode,
        SyntaxNode
    >();
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
            const children = isHtmlRootNode(frame.node)
                ? frame.node.children
                : childNodesOf(frame.node);
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
                throw new Error("An HTML syntax child was not normalized");
            }

            return normalized;
        });
        const location = isHtmlRootNode(frame.node)
            ? { startOffset: 0, endOffset: content.length }
            : frame.node.sourceCodeLocation;

        if (location === undefined || location === null) {
            throw new Error("A located HTML syntax node lost its source range");
        }

        const recoveredChildren = recoverFromParseErrors
            ? recoverChildren(
                normalizedChildren,
                location.startOffset,
                location.endOffset,
            )
            : normalizedChildren;

        normalizedByNode.set(frame.node, {
            type: isHtmlRootNode(frame.node)
                ? frame.node.type
                : htmlNodeType(frame.node),
            range: sourcePositions.createRange(
                location.startOffset,
                location.endOffset,
            ),
            children: recoveredChildren,
        });
    }

    const root = normalizedByNode.get(rootNode);

    if (root === undefined) {
        throw new Error("The HTML syntax root was not normalized");
    }

    return { parserId, root };
}

function recoverChildren(
    children: readonly SyntaxNode[],
    parentStartOffset: number,
    parentEndOffset: number,
): readonly SyntaxNode[] {
    const sourceOrdered = children
        .filter(({ range }) =>
            range.startOffset >= parentStartOffset &&
            range.endOffset <= parentEndOffset
        )
        .sort(compareSyntaxNodesByRange);
    const recovered: SyntaxNode[] = [];

    for (const child of sourceOrdered) {
        let keepChild = true;

        while (recovered.length > 0) {
            const previous = recovered[recovered.length - 1];

            if (
                previous === undefined ||
                child.range.startOffset >= previous.range.endOffset
            ) {
                break;
            }

            if (syntaxNodePriority(child) > syntaxNodePriority(previous)) {
                recovered.pop();
                continue;
            }

            keepChild = false;
            break;
        }

        if (keepChild) {
            recovered.push(child);
        }
    }

    return recovered;
}

function compareSyntaxNodesByRange(left: SyntaxNode, right: SyntaxNode): number {
    return left.range.startOffset - right.range.startOffset ||
        right.range.endOffset - left.range.endOffset ||
        syntaxNodePriority(right) - syntaxNodePriority(left);
}

function syntaxNodePriority(node: SyntaxNode): number {
    if (node.type === "text") {
        return 0;
    }

    if (node.type === "comment") {
        return 1;
    }

    return 2;
}

function childNodesOf(
    node: DefaultTreeAdapterTypes.ChildNode,
): readonly DefaultTreeAdapterTypes.ChildNode[] {
    if ("content" in node) {
        return collectLocatedChildren(node.content.childNodes);
    }

    if ("childNodes" in node) {
        return collectLocatedChildren(node.childNodes);
    }

    return [];
}

function collectLocatedChildren(
    nodes: readonly DefaultTreeAdapterTypes.ChildNode[],
): readonly DefaultTreeAdapterTypes.ChildNode[] {
    const located: DefaultTreeAdapterTypes.ChildNode[] = [];
    const pending = [...nodes].reverse();

    while (pending.length > 0) {
        const node = pending.pop();

        if (node === undefined) {
            break;
        }

        const location = node.sourceCodeLocation;

        if (
            location !== undefined &&
            location !== null &&
            location.endOffset > location.startOffset
        ) {
            located.push(node);
            continue;
        }

        const children = "content" in node
            ? node.content.childNodes
            : "childNodes" in node
                ? node.childNodes
                : [];

        for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];

            if (child !== undefined) {
                pending.push(child);
            }
        }
    }

    return located;
}

function htmlNodeType(node: DefaultTreeAdapterTypes.ChildNode): string {
    if (node.nodeName === "#text") {
        return "text";
    }

    if (node.nodeName === "#comment") {
        return "comment";
    }

    if (node.nodeName === "#documentType") {
        return "doctype";
    }

    if ("tagName" in node) {
        return `element:${node.tagName}`;
    }

    throw new Error("An HTML syntax node has an unknown type");
}

function isHtmlRootNode(
    node: HtmlRootNode | DefaultTreeAdapterTypes.ChildNode,
): node is HtmlRootNode {
    return "kind" in node && node.kind === "root";
}
