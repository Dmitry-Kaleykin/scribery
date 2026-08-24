import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextEncoder } from "node:util";

import { DefaultDocumentDecoder } from "../../decoding/index.js";
import type { ByteSource } from "../../decoding/index.js";
import {
    CastChunkingStrategy,
    ChunkingError,
    createInitialParserRegistry,
    PythonParser,
} from "../index.js";
import type {
    ChunkingDocument,
    SyntaxNode,
} from "../index.js";

function document(
    overrides: Partial<ChunkingDocument> = {},
): ChunkingDocument {
    return {
        path: "src/example.py",
        content: "answer: int = 42\n",
        language: "python",
        format: "python",
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

describe("PythonParser", () => {
    it("registers Python source and stub formats", () => {
        const registry = createInitialParserRegistry();

        assert.equal(
            registry.canParse({ language: "python", format: "python" }),
            true,
        );
        assert.equal(
            registry.canParse({
                language: "python",
                format: "python-stub",
            }),
            true,
        );
        assert.equal(registry.canParse({ language: "python" }), false);
    });

    it("normalizes Python structural nodes", async () => {
        const sourceDocument = document({
            content: [
                "class Greeter:",
                "    def greet(self, name: str) -> str:",
                "        return f\"Hello, {name}\"",
                "",
            ].join("\n"),
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);

        assert.equal(tree.parserId, "tree-sitter-python");
        assert.equal(tree.root.type, "module");
        assert.deepEqual(tree.root.range, {
            startOffset: 0,
            endOffset: sourceDocument.content.length,
            startLine: 1,
            endLine: 3,
        });
        assert.ok(findNode(tree.root, "class_definition"));
        assert.ok(findNode(tree.root, "function_definition"));
        assert.ok(findNode(tree.root, "return_statement"));
    });

    it("parses Python stub files with the same grammar", async () => {
        const sourceDocument = document({
            path: "src/contracts.pyi",
            format: "python-stub",
            content: [
                "from typing import Protocol",
                "",
                "class Reader(Protocol):",
                "    def read(self, size: int = ...) -> str: ...",
                "",
            ].join("\n"),
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);

        assert.ok(findNode(tree.root, "class_definition"));
        assert.ok(findNode(tree.root, "function_definition"));
    });

    it("preserves canonical UTF-16 ranges across Cyrillic, emoji, and CRLF", async () => {
        const sourceDocument = document({
            path: "src/unicode.py",
            content: "# Заголовок 😀\r\nmessage = \"Привет 😀\"\r\n",
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);
        const literal = findNode(tree.root, "string");

        assert.ok(literal);
        assert.equal(
            sourceDocument.content.slice(
                literal.range.startOffset,
                literal.range.endOffset,
            ),
            "\"Привет 😀\"",
        );
        assert.equal(literal.range.startLine, 2);
        assert.equal(literal.range.endLine, 2);
        assert.equal(tree.root.range.endOffset, sourceDocument.content.length);
    });

    it("produces the same AST after UTF-8 and Windows-1251 decoding", async () => {
        const content = "greeting = \"Привет\"\r\n";
        const utf8Bytes = new TextEncoder().encode(content);
        const windows1251Bytes = Uint8Array.from([
            ...new TextEncoder().encode("greeting = \""),
            0xcf,
            0xf0,
            0xe8,
            0xe2,
            0xe5,
            0xf2,
            ...new TextEncoder().encode("\"\r\n"),
        ]);
        const decoder = new DefaultDocumentDecoder();
        const [utf8, windows1251] = await Promise.all([
            decoder.decode({
                path: "modern/greeting.py",
                bytes: bytesFrom(utf8Bytes),
                encodingSelection: {},
            }),
            decoder.decode({
                path: "legacy/greeting.py",
                bytes: bytesFrom(windows1251Bytes),
                encodingSelection: { fallback: "windows-1251" },
            }),
        ]);
        const registry = createInitialParserRegistry();
        const [utf8Tree, windows1251Tree] = await Promise.all([
            registry.parse(document({ content: utf8.content })),
            registry.parse(document({ content: windows1251.content })),
        ]);

        assert.equal(utf8.content, content);
        assert.equal(windows1251.content, content);
        assert.deepEqual(windows1251Tree, utf8Tree);
    });

    it("chunks Python through cAST without losing source text", async () => {
        const content = [
            "def first():",
            "    value = 1",
            "    return value",
            "",
            "def second():",
            "    value = 2",
            "    return value",
            "",
        ].join("\n");
        const strategy = new CastChunkingStrategy(
            createInitialParserRegistry(),
        );
        const chunks = await strategy.chunk(
            document({ content }),
            { maximumSize: 55, sizeUnit: "utf16-code-units" },
        );

        assert.equal(chunks.length, 2);
        assert.deepEqual(
            chunks.map(({ kind }) => kind),
            ["function_definition", "function_definition"],
        );
        assert.equal(
            chunks.map(({ content: chunk }) => chunk).join(""),
            content,
        );
    });

    it("reports malformed syntax without including decoded source text", async () => {
        const sourceDocument = document({
            content: "def secret(:\n    pass\n",
        });

        await assert.rejects(
            createInitialParserRegistry().parse(sourceDocument),
            (error: unknown) => {
                assert.ok(error instanceof ChunkingError);
                assert.equal(error.code, "parser-failure");
                assert.equal(error.details.path, sourceDocument.path);
                assert.equal(error.details.parserId, "tree-sitter-python");
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
            new PythonParser().parse(
                document({
                    path: "src/example.ts",
                    language: "typescript",
                    format: "typescript",
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
