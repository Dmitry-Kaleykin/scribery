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
import { TypeScriptParser } from "../typescript/typescript-parser.js";
import {
    VUE_PARSER_ID,
    VUE_PARSER_TARGETS,
} from "./constants/parser.js";

interface ScriptFormat {
    language: "javascript" | "typescript";
    format:
        | "javascript"
        | "javascript-jsx"
        | "typescript"
        | "typescript-jsx";
}

export class VueParser implements CodeParserAdapter {
    readonly id = VUE_PARSER_ID;
    readonly targets = VUE_PARSER_TARGETS;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        if (document.language !== "vue" || document.format !== "vue") {
            throw new ChunkingError(
                "unsupported-parser",
                `Parser ${this.id} does not support ${document.path}`,
                { path: document.path, language: document.language },
            );
        }

        const htmlTree = parseHtmlSyntaxTree(
            document.content,
            document.path,
            this.id,
            "vue_component",
            {
                recoverFromParseErrors: true,
                ...(options.signal === undefined
                    ? {}
                    : { signal: options.signal }),
            },
        );
        const sourcePositions = new SourcePositionIndex(document.content);
        const root = await embedScripts(
            htmlTree.root,
            document,
            sourcePositions,
            options,
        );

        return { parserId: this.id, root };
    }
}

async function embedScripts(
    node: SyntaxNode,
    document: ChunkingDocument,
    sourcePositions: SourcePositionIndex,
    options: ParserOptions,
): Promise<SyntaxNode> {
    const children: SyntaxNode[] = [];

    for (const child of node.children) {
        children.push(
            await embedScripts(child, document, sourcePositions, options),
        );
    }

    if (node.type !== "element:script") {
        return { ...node, children };
    }

    const textChildIndex = children.findIndex(({ type }) => type === "text");

    if (textChildIndex < 0) {
        return { ...node, children };
    }

    const textChild = children[textChildIndex];

    if (textChild === undefined) {
        return { ...node, children };
    }

    const content = document.content.slice(
        textChild.range.startOffset,
        textChild.range.endOffset,
    );

    if (content.length === 0) {
        return { ...node, children };
    }

    const openingTag = document.content.slice(
        node.range.startOffset,
        textChild.range.startOffset,
    );
    const scriptFormat = scriptFormatFrom(openingTag);
    const tree = await new TypeScriptParser().parse(
        {
            path: `${document.path}#script`,
            content,
            language: scriptFormat.language,
            format: scriptFormat.format,
        },
        options,
    );
    const embeddedRoot = shiftSyntaxNode(
        tree.root,
        textChild.range.startOffset,
        sourcePositions,
        `embedded:${scriptFormat.format}`,
    );
    const embeddedChildren = [...children];
    embeddedChildren[textChildIndex] = embeddedRoot;

    return { ...node, children: embeddedChildren };
}

function scriptFormatFrom(openingTag: string): ScriptFormat {
    const match = /\blang\s*=\s*["']?([^"'\s>]+)/iu.exec(openingTag);
    const language = match?.[1]?.toLowerCase();

    switch (language) {
        case "ts":
        case "typescript":
            return { language: "typescript", format: "typescript" };
        case "tsx":
            return { language: "typescript", format: "typescript-jsx" };
        case "jsx":
            return { language: "javascript", format: "javascript-jsx" };
        default:
            return { language: "javascript", format: "javascript" };
    }
}

function shiftSyntaxNode(
    node: SyntaxNode,
    offset: number,
    sourcePositions: SourcePositionIndex,
    rootType?: string,
): SyntaxNode {
    return {
        type: rootType ?? node.type,
        range: sourcePositions.createRange(
            node.range.startOffset + offset,
            node.range.endOffset + offset,
        ),
        children: node.children.map((child) =>
            shiftSyntaxNode(child, offset, sourcePositions)
        ),
    };
}
