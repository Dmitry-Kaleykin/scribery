import { SourcePositionIndex } from "../../../metadata/index.js";
import type { ChunkingDocument } from "../../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
} from "../../contracts/parser.js";
import type {
    NormalizedSyntaxTree,
    SyntaxNode,
} from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import { parseHtmlSyntaxTree } from "../html/parse-html.js";
import {
    TWIG_PARSER_ID,
    TWIG_PARSER_TARGETS,
} from "./constants/parser.js";

interface TwigDelimiter {
    opening: "{{" | "{%" | "{#";
    closing: "}}" | "%}" | "#}";
    type: string;
}

const TWIG_DELIMITERS: readonly TwigDelimiter[] = [
    { opening: "{{", closing: "}}", type: "twig_output" },
    { opening: "{%", closing: "%}", type: "twig_tag" },
    { opening: "{#", closing: "#}", type: "twig_comment" },
];

export class TwigParser implements CodeParserAdapter {
    readonly id = TWIG_PARSER_ID;
    readonly targets = TWIG_PARSER_TARGETS;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        if (document.language !== "twig" || document.format !== "twig") {
            throw new ChunkingError(
                "unsupported-parser",
                `Parser ${this.id} does not support ${document.path}`,
                { path: document.path, language: document.language },
            );
        }

        validateTwigDelimiters(document);

        const tree = parseHtmlSyntaxTree(
            document.content,
            document.path,
            this.id,
            "twig_document",
            {
                recoverFromParseErrors: true,
                ...(options.signal === undefined
                    ? {}
                    : { signal: options.signal }),
            },
        );
        const sourcePositions = new SourcePositionIndex(document.content);

        return {
            parserId: this.id,
            root: decorateTwigNode(tree.root, document.content, sourcePositions),
        };
    }
}

function validateTwigDelimiters(document: ChunkingDocument): void {
    for (let offset = 0; offset < document.content.length; offset += 1) {
        const delimiter = TWIG_DELIMITERS.find(({ opening }) =>
            document.content.startsWith(opening, offset)
        );

        if (delimiter === undefined) {
            continue;
        }

        const end = document.content.indexOf(
            delimiter.closing,
            offset + delimiter.opening.length,
        );

        if (end < 0) {
            throw new ChunkingError(
                "parser-failure",
                `Parser ${TWIG_PARSER_ID} found invalid syntax in ${document.path}`,
                {
                    path: document.path,
                    parserId: TWIG_PARSER_ID,
                    diagnostics: [{
                        code: "unclosed-twig-delimiter",
                        startOffset: offset,
                    }],
                },
            );
        }

        offset = end + delimiter.closing.length - 1;
    }
}

function decorateTwigNode(
    node: SyntaxNode,
    content: string,
    sourcePositions: SourcePositionIndex,
): SyntaxNode {
    if (node.type === "text") {
        const parts = splitTextNode(node, content, sourcePositions);

        if (parts.length === 1 && parts[0] !== undefined) {
            return parts[0];
        }

        return { ...node, type: "twig_text", children: parts };
    }

    const children = node.children.map((child) =>
        decorateTwigNode(child, content, sourcePositions)
    );
    const augmented: SyntaxNode[] = [];
    let cursor = node.range.startOffset;

    for (const child of children) {
        augmented.push(
            ...twigTokensInRange(cursor, child.range.startOffset, content, sourcePositions),
            child,
        );
        cursor = child.range.endOffset;
    }

    augmented.push(
        ...twigTokensInRange(cursor, node.range.endOffset, content, sourcePositions),
    );

    return { ...node, children: augmented };
}

function splitTextNode(
    node: SyntaxNode,
    content: string,
    sourcePositions: SourcePositionIndex,
): readonly SyntaxNode[] {
    const tokens = twigTokensInRange(
        node.range.startOffset,
        node.range.endOffset,
        content,
        sourcePositions,
    );

    if (tokens.length === 0) {
        return [node];
    }

    const parts: SyntaxNode[] = [];
    let cursor = node.range.startOffset;

    for (const token of tokens) {
        if (token.range.startOffset > cursor) {
            parts.push({
                type: "text",
                range: sourcePositions.createRange(
                    cursor,
                    token.range.startOffset,
                ),
                children: [],
            });
        }

        parts.push(token);
        cursor = token.range.endOffset;
    }

    if (cursor < node.range.endOffset) {
        parts.push({
            type: "text",
            range: sourcePositions.createRange(cursor, node.range.endOffset),
            children: [],
        });
    }

    return parts;
}

function twigTokensInRange(
    startOffset: number,
    endOffset: number,
    content: string,
    sourcePositions: SourcePositionIndex,
): readonly SyntaxNode[] {
    const nodes: SyntaxNode[] = [];

    for (let offset = startOffset; offset < endOffset; offset += 1) {
        const delimiter = TWIG_DELIMITERS.find(({ opening }) =>
            content.startsWith(opening, offset)
        );

        if (delimiter === undefined) {
            continue;
        }

        const closingOffset = content.indexOf(
            delimiter.closing,
            offset + delimiter.opening.length,
        );
        const tokenEnd = closingOffset + delimiter.closing.length;

        if (closingOffset < 0 || tokenEnd > endOffset) {
            continue;
        }

        const tokenContent = content.slice(
            offset + delimiter.opening.length,
            closingOffset,
        ).trim();
        const keyword = delimiter.type === "twig_tag"
            ? /^[a-z_][a-z0-9_]*/iu.exec(tokenContent)?.[0]
            : undefined;

        nodes.push({
            type: keyword === undefined
                ? delimiter.type
                : `${delimiter.type}:${keyword.toLowerCase()}`,
            range: sourcePositions.createRange(offset, tokenEnd),
            children: [],
        });
        offset = tokenEnd - 1;
    }

    return nodes;
}
