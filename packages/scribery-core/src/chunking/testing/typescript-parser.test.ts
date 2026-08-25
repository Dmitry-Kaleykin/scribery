import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextEncoder } from "node:util";

import { DefaultDocumentDecoder } from "../../decoding/index.js";
import type { ByteSource } from "../../decoding/index.js";
import {
    CastChunkingStrategy,
    ChunkingError,
    createInitialParserRegistry,
    TypeScriptParser,
} from "../index.js";
import type {
    ChunkingDocument,
    SyntaxNode,
} from "../index.js";

function document(
    overrides: Partial<ChunkingDocument> = {},
): ChunkingDocument {
    return {
        path: "src/example.ts",
        content: "export const answer: number = 42;\n",
        language: "typescript",
        format: "typescript",
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

describe("TypeScriptParser", () => {
    it("registers the four classified TypeScript and JavaScript formats", () => {
        const registry = createInitialParserRegistry();

        assert.equal(
            registry.canParse({
                language: "typescript",
                format: "typescript",
            }),
            true,
        );
        assert.equal(
            registry.canParse({
                language: "typescript",
                format: "typescript-jsx",
            }),
            true,
        );
        assert.equal(
            registry.canParse({
                language: "javascript",
                format: "javascript",
            }),
            true,
        );
        assert.equal(
            registry.canParse({
                language: "javascript",
                format: "javascript-jsx",
            }),
            true,
        );
        assert.equal(registry.canParse({ language: "typescript" }), false);
        assert.equal(
            registry.canParse({ language: "python", format: "python" }),
            true,
        );
    });

    it("normalizes a TypeScript AST with useful structural node names", async () => {
        const sourceDocument = document({
            content: [
                "interface Greeter {",
                "    greet(name: string): string;",
                "}",
                "",
                "export function greet(name: string): string {",
                "    return `Hello, ${name}`;",
                "}",
                "",
            ].join("\n"),
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);

        assert.equal(tree.parserId, "typescript-compiler-v2");
        assert.equal(tree.root.type, "SourceFile");
        assert.deepEqual(tree.root.range, {
            startOffset: 0,
            endOffset: sourceDocument.content.length,
            startLine: 1,
            endLine: 7,
        });
        assert.ok(findNode(tree.root, "InterfaceDeclaration"));
        assert.ok(findNode(tree.root, "FunctionDeclaration"));
        assert.ok(findNode(tree.root, "ReturnStatement"));
        assert.equal(findNode(tree.root, "FirstStatement"), undefined);
    });

    it("keeps punctuation tokens in source envelopes instead of AST nodes", async () => {
        const sourceDocument = document({
            path: "server/app.test.ts",
            content: [
                "describe(\"local UI server boundary\", () => {",
                "    it(\"first\", () => {",
                ...variableDeclarations(0),
                "    });",
                "",
                "    it(\"second\", () => {",
                ...variableDeclarations(20),
                "    });",
                "});",
                "",
            ].join("\n"),
        });
        const registry = createInitialParserRegistry();
        const tree = await registry.parse(sourceDocument);

        assert.equal(findNode(tree.root, "EqualsGreaterThanToken"), undefined);

        const chunks = await new CastChunkingStrategy(registry).chunk(
            sourceDocument,
            {
                maximumSize: 1_000,
                sizeUnit: "utf16-code-units",
            },
        );
        const suite = chunks.find(({ content }) =>
            content.includes("describe(\"local UI server boundary\"")
        );

        assert.ok(suite);
        assert.ok(suite.content.startsWith(
            "describe(\"local UI server boundary\", () => {\n",
        ));
        assert.ok(suite.content.includes("const value0 = 0;"));
        assert.ok(chunks.every(({ content }) => content.trim() !== "() =>"));
        assert.ok(chunks.every(({ content }) =>
            !content.trimEnd().endsWith(",")
        ));
        assert.equal(
            chunks.map(({ content }) => content).join(""),
            sourceDocument.content,
        );
    });

    it("reserves room for a declaration prefix when recursively splitting its value", async () => {
        const maximumSize = 240;
        const sourceDocument = document({
            path: "frontend/buildCommon/entries.mjs",
            language: "javascript",
            format: "javascript",
            content: [
                "const entries = {",
                ...Array.from(
                    { length: 40 },
                    (_, index) =>
                        `    entry${index}: "./src/module-${index}/index.js",`,
                ),
                "};",
                "",
            ].join("\n"),
        });
        const chunks = await new CastChunkingStrategy(
            createInitialParserRegistry(),
        ).chunk(sourceDocument, {
            maximumSize,
            sizeUnit: "utf16-code-units",
        });

        assert.ok(chunks.length > 1);
        assert.ok(chunks[0]?.content.startsWith("const entries = {\n"));
        assert.ok(chunks[0]?.content.includes("entry0:"));
        assert.ok(chunks.every(({ content }) => content.length <= maximumSize));
        assert.ok(chunks.every(({ content }) =>
            content.trim() !== "const entries ="
        ));
        assert.equal(
            chunks.map(({ content }) => content).join(""),
            sourceDocument.content,
        );
    });

    it("keeps JavaScript block headers with the first part of oversized bodies", async () => {
        const maximumSize = 240;
        const repeatedAssignments = Array.from(
            { length: 24 },
            (_, index) => `                result.value${index} = ${index};`,
        );
        const sourceDocument = document({
            path: "src/resolution.js",
            language: "javascript",
            format: "javascript",
            content: [
                "export default class Resolution {",
                "    constructor(initialResolution = null)",
                "    {",
                ...Array.from(
                    { length: 16 },
                    (_, index) => `        this.value${index} = ${index};`,
                ),
                "    }",
                "",
                "    init(data)",
                "    {",
                "        try {",
                "            for (const key in data)",
                "            {",
                "                if (data[key])",
                "                {",
                ...repeatedAssignments,
                "                }",
                "                else",
                "                {",
                "                    result.empty = true;",
                "                }",
                "            }",
                "        }",
                "        catch (error)",
                "        {",
                "            report(error);",
                "        }",
                "    }",
                "}",
                "",
            ].join("\n"),
        });
        const chunks = await new CastChunkingStrategy(
            createInitialParserRegistry(),
        ).chunk(sourceDocument, {
            maximumSize,
            sizeUnit: "utf16-code-units",
        });
        const headers = [
            "constructor(initialResolution = null)",
            "init(data)",
            "for (const key in data)",
            "if (data[key])",
            "else",
            "catch (error)",
        ];

        for (const header of headers) {
            const containingChunk = chunks.find(({ content }) =>
                content.includes(header)
            );

            assert.ok(containingChunk, header);
            assert.match(
                containingChunk.content.slice(
                    containingChunk.content.indexOf(header) + header.length,
                ),
                /\s*\{\s*\S/u,
                header,
            );
        }

        assert.ok(chunks.every(({ content }) =>
            content.length <= maximumSize
        ));
        assert.equal(
            chunks.map(({ content }) => content).join(""),
            sourceDocument.content,
        );
    });

    it("uses TSX and JSX script kinds for their exact formats", async () => {
        const registry = createInitialParserRegistry();
        const typescriptTree = await registry.parse(
            document({
                path: "src/view.tsx",
                content: "export const View = () => <main>TypeScript</main>;\n",
                format: "typescript-jsx",
            }),
        );
        const javascriptTree = await registry.parse(
            document({
                path: "src/view.jsx",
                content: "export const View = () => <main>JavaScript</main>;\n",
                language: "javascript",
                format: "javascript-jsx",
            }),
        );

        assert.ok(findNode(typescriptTree.root, "JsxElement"));
        assert.ok(findNode(javascriptTree.root, "JsxElement"));
    });

    it("preserves canonical UTF-16 ranges across Cyrillic, emoji, and CRLF", async () => {
        const sourceDocument = document({
            path: "src/unicode.ts",
            content: "// Привет 😀\r\nconst message = \"мир\";\r\n",
        });
        const tree = await createInitialParserRegistry().parse(sourceDocument);
        const literal = findNode(tree.root, "StringLiteral");

        assert.ok(literal);
        assert.equal(
            sourceDocument.content.slice(
                literal.range.startOffset,
                literal.range.endOffset,
            ),
            " \"мир\"",
        );
        assert.equal(literal.range.startLine, 2);
        assert.equal(literal.range.endLine, 2);
        assert.equal(tree.root.range.endOffset, sourceDocument.content.length);
    });

    it("produces the same AST after UTF-8 and Windows-1251 decoding", async () => {
        const content = "const greeting = \"Привет\";\r\n";
        const utf8Bytes = new TextEncoder().encode(content);
        const windows1251Bytes = Uint8Array.from([
            ...new TextEncoder().encode("const greeting = \""),
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
                path: "modern/greeting.ts",
                bytes: bytesFrom(utf8Bytes),
                encodingSelection: {},
            }),
            decoder.decode({
                path: "legacy/greeting.ts",
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

    it("reports malformed syntax without including decoded source text", async () => {
        const sourceDocument = document({
            content: "function secret( {",
        });

        await assert.rejects(
            createInitialParserRegistry().parse(sourceDocument),
            (error: unknown) => {
                assert.ok(error instanceof ChunkingError);
                assert.equal(error.code, "parser-failure");
                assert.equal(error.details.path, sourceDocument.path);
                assert.equal(error.details.parserId, "typescript-compiler-v2");
                assert.ok(Array.isArray(error.details.diagnostics));
                assert.equal(error.details.diagnostics.length, 1);
                assert.doesNotMatch(error.message, /secret/);
                assert.doesNotMatch(JSON.stringify(error.details), /secret/);
                return true;
            },
        );
    });

    it("rejects unsupported targets when the adapter is called directly", async () => {
        await assert.rejects(
            new TypeScriptParser().parse(
                document({ language: "python", format: "python" }),
            ),
            (error: unknown) => {
                assert.ok(error instanceof ChunkingError);
                assert.equal(error.code, "unsupported-parser");
                return true;
            },
        );
    });
});

function variableDeclarations(start: number): readonly string[] {
    return Array.from(
        { length: 20 },
        (_, index) => `        const value${start + index} = ${start + index};`,
    );
}
