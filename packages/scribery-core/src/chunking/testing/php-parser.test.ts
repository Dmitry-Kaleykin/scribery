import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextEncoder } from "node:util";

import { DefaultDocumentDecoder } from "../../decoding/index.js";
import type { ByteSource } from "../../decoding/index.js";
import {
    CastChunkingStrategy,
    ChunkingError,
    createInitialParserRegistry,
    PhpParser,
} from "../index.js";
import type {
    ChunkingDocument,
    SyntaxNode,
} from "../index.js";

function document(
    overrides: Partial<ChunkingDocument> = {},
): ChunkingDocument {
    return {
        path: "src/example.php",
        content: "<?php\n$answer = 42;\n",
        language: "php",
        format: "php",
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

function bytesFrom(bytes: Uint8Array): ByteSource {
    return {
        async *read() {
            yield bytes;
        },
    };
}

describe("PhpParser", () => {
    it("registers the canonical PHP target used by .php and .inc files", () => {
        const registry = createInitialParserRegistry();

        assert.equal(
            registry.canParse({ language: "php", format: "php" }),
            true,
        );
        assert.equal(registry.canParse({ language: "php" }), false);
    });

    it("normalizes useful PHP structural nodes", async () => {
        const sourceDocument = document({
            content: [
                "<?php",
                "class Greeter {",
                "    public function greet(string $name): string {",
                "        return \"Hello, {$name}\";",
                "    }",
                "}",
                "",
            ].join("\n"),
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);

        assert.equal(tree.parserId, "tree-sitter-php");
        assert.equal(tree.root.type, "program");
        assert.deepEqual(tree.root.range, {
            startOffset: 0,
            endOffset: sourceDocument.content.length,
            startLine: 1,
            endLine: 6,
        });
        assert.ok(findNode(tree.root, "class_declaration"));
        assert.ok(findNode(tree.root, "method_declaration"));
        assert.ok(findNode(tree.root, "return_statement"));
    });

    it("parses PHP include files through the same canonical target", async () => {
        const tree = await createInitialParserRegistry().parse(
            document({
                path: "legacy/bootstrap.inc",
                content: [
                    "<?php",
                    "function bootstrap(): void {",
                    "    require_once 'config.php';",
                    "}",
                    "",
                ].join("\n"),
            }),
        );

        assert.ok(findNode(tree.root, "function_definition"));
        assert.ok(findNode(tree.root, "require_once_expression"));
    });

    it("preserves mixed HTML surrounding PHP syntax", async () => {
        const sourceDocument = document({
            path: "public/page.php",
            content: "<main><?php echo $title; ?></main>\n",
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);

        assert.ok(findNode(tree.root, "text"));
        assert.ok(findNode(tree.root, "echo_statement"));
        assert.ok(findNode(tree.root, "text_interpolation"));
        assert.equal(tree.root.range.endOffset, sourceDocument.content.length);
    });

    it("preserves canonical UTF-16 ranges across Cyrillic, emoji, and CRLF", async () => {
        const sourceDocument = document({
            path: "src/unicode.php",
            content: "<?php\r\n// Заголовок 😀\r\n$message = \"Привет 😀\";\r\n",
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);
        const literal = findNode(tree.root, "encapsed_string");

        assert.ok(literal);
        assert.equal(
            sourceDocument.content.slice(
                literal.range.startOffset,
                literal.range.endOffset,
            ),
            "\"Привет 😀\"",
        );
        assert.equal(literal.range.startLine, 3);
        assert.equal(literal.range.endLine, 3);
        assert.equal(tree.root.range.endOffset, sourceDocument.content.length);
    });

    it("produces the same AST after UTF-8 and Windows-1251 decoding", async () => {
        const content = "<?php\r\n$greeting = \"Привет\";\r\n";
        const utf8Bytes = new TextEncoder().encode(content);
        const windows1251Bytes = Uint8Array.from([
            ...new TextEncoder().encode("<?php\r\n$greeting = \""),
            0xcf,
            0xf0,
            0xe8,
            0xe2,
            0xe5,
            0xf2,
            ...new TextEncoder().encode("\";\r\n"),
        ]);
        const decoder = new DefaultDocumentDecoder();
        const [utf8, windows1251] = await Promise.all([
            decoder.decode({
                path: "modern/greeting.php",
                bytes: bytesFrom(utf8Bytes),
                encodingSelection: {},
            }),
            decoder.decode({
                path: "legacy/greeting.inc",
                bytes: bytesFrom(windows1251Bytes),
                encodingSelection: { fallback: "windows-1251" },
            }),
        ]);
        const registry = createInitialParserRegistry();
        const [utf8Tree, windows1251Tree] = await Promise.all([
            registry.parse(document({ content: utf8.content })),
            registry.parse(
                document({
                    path: "legacy/greeting.inc",
                    content: windows1251.content,
                }),
            ),
        ]);

        assert.equal(utf8.content, content);
        assert.equal(windows1251.content, content);
        assert.deepEqual(windows1251Tree, utf8Tree);
    });

    it("chunks PHP through cAST without losing source text", async () => {
        const content = [
            "<?php",
            "function first(): int {",
            "    return 1;",
            "}",
            "",
            "function second(): int {",
            "    return 2;",
            "}",
            "",
        ].join("\n");
        const strategy = new CastChunkingStrategy(
            createInitialParserRegistry(),
        );
        const chunks = await strategy.chunk(
            document({ content }),
            { maximumSize: 55, sizeUnit: "utf16-code-units" },
        );

        assert.ok(chunks.length > 1);
        assert.equal(
            chunks.map(({ content: chunk }) => chunk).join(""),
            content,
        );
    });

    it("reports malformed syntax without including decoded source text", async () => {
        const sourceDocument = document({
            content: "<?php function secret( {\n",
        });

        await assert.rejects(
            createInitialParserRegistry().parse(sourceDocument),
            (error: unknown) => {
                assert.ok(error instanceof ChunkingError);
                assert.equal(error.code, "parser-failure");
                assert.equal(error.details.path, sourceDocument.path);
                assert.equal(error.details.parserId, "tree-sitter-php");
                assert.ok(Array.isArray(error.details.diagnostics));
                assert.ok(error.details.diagnostics.length > 0);
                assert.doesNotMatch(error.message, /secret/);
                assert.doesNotMatch(JSON.stringify(error.details), /secret/);
                return true;
            },
        );
    });

    it("rejects unsupported targets when the adapter is called directly", async () => {
        await assert.rejects(
            new PhpParser().parse(
                document({
                    path: "templates/page.twig",
                    language: "twig",
                    format: "twig",
                }),
            ),
            (error: unknown) => {
                assert.ok(error instanceof ChunkingError);
                assert.equal(error.code, "unsupported-parser");
                return true;
            },
        );
    });
});
