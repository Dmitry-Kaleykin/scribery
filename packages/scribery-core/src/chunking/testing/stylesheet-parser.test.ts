import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    CastChunkingStrategy,
    ChunkingError,
    createInitialParserRegistry,
    StylesheetParser,
} from "../index.js";
import type {
    ChunkingDocument,
    SyntaxNode,
} from "../index.js";

function document(
    overrides: Partial<ChunkingDocument> = {},
): ChunkingDocument {
    return {
        path: "styles/app.css",
        content: ".app { color: #245edb; }\n",
        language: "css",
        format: "css",
        ...overrides,
    };
}

function findNode(root: SyntaxNode, type: string): SyntaxNode | undefined {
    const pending = [root];

    while (pending.length > 0) {
        const node = pending.pop();

        if (node === undefined) {
            break;
        }

        if (node.type === type) {
            return node;
        }

        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            const child = node.children[index];

            if (child !== undefined) {
                pending.push(child);
            }
        }
    }

    return undefined;
}

describe("StylesheetParser", () => {
    it("registers exact CSS and SCSS targets", () => {
        const registry = createInitialParserRegistry();

        assert.equal(
            registry.canParse({ language: "css", format: "css" }),
            true,
        );
        assert.equal(
            registry.canParse({ language: "scss", format: "scss" }),
            true,
        );
        assert.equal(registry.canParse({ language: "css" }), false);
        assert.equal(registry.canParse({ language: "scss" }), false);
    });

    it("normalizes CSS rules, declarations, comments, and at-rules", async () => {
        const sourceDocument = document({
            content: [
                "/* Theme */",
                ":root { --brand: #245edb; }",
                "@media (width > 40rem) {",
                "    .app { color: var(--brand); }",
                "}",
                "",
            ].join("\n"),
        });
        const tree = await new StylesheetParser().parse(sourceDocument);

        assert.equal(tree.parserId, "postcss-stylesheet");
        assert.equal(tree.root.type, "stylesheet");
        assert.deepEqual(tree.root.range, {
            startOffset: 0,
            endOffset: sourceDocument.content.length,
            startLine: 1,
            endLine: 5,
        });
        assert.ok(findNode(tree.root, "comment"));
        assert.ok(findNode(tree.root, "rule"));
        assert.ok(findNode(tree.root, "declaration"));
        assert.ok(findNode(tree.root, "at_rule:media"));
    });

    it("normalizes SCSS variables, mixins, and nested selectors", async () => {
        const sourceDocument = document({
            path: "styles/theme.scss",
            language: "scss",
            format: "scss",
            content: [
                "$brand: #245edb;",
                "@mixin interactive {",
                "    &:hover { color: $brand; }",
                "}",
                ".button {",
                "    @include interactive;",
                "    &__icon { color: $brand; }",
                "}",
                "",
            ].join("\n"),
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);

        assert.ok(findNode(tree.root, "declaration"));
        assert.ok(findNode(tree.root, "at_rule:mixin"));
        assert.ok(findNode(tree.root, "at_rule:include"));
        assert.ok(findNode(tree.root, "rule"));
        assert.equal(tree.root.range.endOffset, sourceDocument.content.length);
    });

    it("preserves canonical UTF-16 ranges across Cyrillic, emoji, and CRLF", async () => {
        const sourceDocument = document({
            content: [
                "/* Заголовок 😀 */",
                ".message { content: \"Привет 😀\"; }",
                "",
            ].join("\r\n"),
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);
        const declaration = findNode(tree.root, "declaration");

        assert.ok(declaration);
        assert.equal(
            sourceDocument.content.slice(
                declaration.range.startOffset,
                declaration.range.endOffset,
            ),
            "content: \"Привет 😀\";",
        );
        assert.equal(declaration.range.startLine, 2);
        assert.equal(declaration.range.endLine, 2);
    });

    it("rejects malformed CSS and SCSS without exposing source text", async () => {
        const malformed: readonly ChunkingDocument[] = [
            document({ content: ".app { color: red;\n" }),
            document({
                path: "styles/theme.scss",
                language: "scss",
                format: "scss",
                content: "@mixin button {\n.button { color: red; }\n",
            }),
        ];

        for (const sourceDocument of malformed) {
            await assert.rejects(
                createInitialParserRegistry().parse(sourceDocument),
                (error: unknown) => {
                    assert.ok(error instanceof ChunkingError);
                    assert.equal(error.code, "parser-failure");
                    assert.doesNotMatch(
                        JSON.stringify(error.details),
                        /color: red/u,
                    );
                    return true;
                },
            );
        }
    });

    it("chunks CSS and SCSS through cAST without losing source text", async () => {
        const documents: readonly ChunkingDocument[] = [
            document({
                content: [
                    ".first { color: red; }",
                    ".second { color: blue; }",
                    ".third { color: green; }",
                    "",
                ].join("\n"),
            }),
            document({
                path: "styles/theme.scss",
                language: "scss",
                format: "scss",
                content: [
                    "$brand: blue;",
                    ".first { color: $brand; }",
                    ".second { &:hover { color: $brand; } }",
                    "",
                ].join("\n"),
            }),
        ];
        const strategy = new CastChunkingStrategy(
            createInitialParserRegistry(),
        );

        for (const sourceDocument of documents) {
            const chunks = await strategy.chunk(sourceDocument, {
                maximumSize: 35,
                sizeUnit: "utf16-code-units",
            });

            assert.ok(chunks.length > 1);
            assert.equal(
                chunks.map(({ content }) => content).join(""),
                sourceDocument.content,
            );
        }
    });
});
