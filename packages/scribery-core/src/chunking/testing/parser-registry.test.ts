import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SourcePositionIndex } from "../../metadata/index.js";
import {
    ChunkingError,
    ParserRegistry,
} from "../index.js";
import type {
    ChunkingDocument,
    NormalizedSyntaxTree,
    ParserTarget,
    SyntaxNode,
} from "../index.js";
import { FakeParser } from "./fake-parser.js";

function document(
    overrides: Partial<ChunkingDocument> = {},
): ChunkingDocument {
    return {
        path: "src/example.ts",
        content: "const first = 1;\nconst second = 2;\n",
        language: "typescript",
        format: "typescript",
        ...overrides,
    };
}

function treeFor(
    sourceDocument: ChunkingDocument,
    parserId: string,
    children: readonly SyntaxNode[] = [],
): NormalizedSyntaxTree {
    const sourcePositions = new SourcePositionIndex(sourceDocument.content);

    return {
        parserId,
        root: {
            type: "program",
            range: sourcePositions.createRange(0, sourceDocument.content.length),
            children,
        },
    };
}

function parser(
    id: string,
    targets: readonly ParserTarget[] = [
        { language: "typescript", format: "typescript" },
    ],
): FakeParser {
    return new FakeParser(id, targets, (sourceDocument) =>
        treeFor(sourceDocument, id),
    );
}

function expectChunkingError(
    error: unknown,
    code: ChunkingError["code"],
): boolean {
    assert.ok(error instanceof ChunkingError);
    assert.equal(error.code, code);
    return true;
}

describe("ParserRegistry", () => {
    it("resolves exact format targets before language fallbacks", () => {
        const fallbackParser = parser("typescript-parser", [
            { language: "typescript" },
        ]);
        const jsxParser = parser("tsx-parser", [
            { language: "typescript", format: "typescript-jsx" },
        ]);
        const registry = new ParserRegistry([fallbackParser, jsxParser]);

        assert.equal(
            registry.resolve({
                language: "TYPESCRIPT",
                format: "typescript-jsx",
            }),
            jsxParser,
        );
        assert.equal(
            registry.resolve({
                language: "typescript",
                format: "typescript",
            }),
            fallbackParser,
        );
        assert.equal(registry.canParse({ language: "python" }), false);
        assert.deepEqual(
            registry.parserIds(),
            ["tsx-parser", "typescript-parser"],
        );
    });

    it("provides the capability consumed by code-only indexing policy", () => {
        const registry = new ParserRegistry([parser("typescript-parser")]);
        const sourceDocument = document();
        const capabilities = {
            canChunkWithCast: registry.canParse(sourceDocument),
        };

        assert.deepEqual(capabilities, { canChunkWithCast: true });
    });

    it("parses through the selected adapter and validates its tree", async () => {
        const fakeParser = parser("typescript-parser");
        const registry = new ParserRegistry([fakeParser]);
        const sourceDocument = document();
        const tree = await registry.parse(sourceDocument);

        assert.equal(tree.parserId, fakeParser.id);
        assert.equal(fakeParser.parseCount, 1);
        assert.equal(tree.root.range.endOffset, sourceDocument.content.length);
    });

    it("rejects duplicate parser IDs and targets", () => {
        assert.throws(
            () =>
                new ParserRegistry([
                    parser("duplicate-parser"),
                    parser("duplicate-parser", [
                        { language: "python", format: "python" },
                    ]),
                ]),
            (error: unknown) =>
                expectChunkingError(error, "duplicate-parser"),
        );
        assert.throws(
            () =>
                new ParserRegistry([
                    parser("first-parser"),
                    parser("second-parser"),
                ]),
            (error: unknown) =>
                expectChunkingError(error, "duplicate-parser-target"),
        );
        assert.throws(
            () =>
                new ParserRegistry([
                    parser("repeated-target-parser", [
                        { language: "typescript" },
                        { language: "TYPESCRIPT" },
                    ]),
                ]),
            (error: unknown) =>
                expectChunkingError(error, "duplicate-parser-target"),
        );
    });

    it("rejects invalid parser declarations", () => {
        assert.throws(
            () => new ParserRegistry([parser("Invalid Parser")]),
            (error: unknown) =>
                expectChunkingError(error, "invalid-parser"),
        );
        assert.throws(
            () => new ParserRegistry([parser("targetless-parser", [])]),
            (error: unknown) =>
                expectChunkingError(error, "invalid-parser"),
        );
    });

    it("returns a structured unsupported-parser error", async () => {
        const registry = new ParserRegistry();

        await assert.rejects(
            registry.parse(document()),
            (error: unknown) =>
                expectChunkingError(error, "unsupported-parser"),
        );
    });

    it("wraps adapter failures without exposing source content", async () => {
        const cause = new Error("native parser failure");
        const failingParser = new FakeParser(
            "failing-parser",
            [{ language: "typescript" }],
            () => {
                throw cause;
            },
        );
        const registry = new ParserRegistry([failingParser]);

        await assert.rejects(
            registry.parse(document()),
            (error: unknown) => {
                assert.ok(error instanceof ChunkingError);
                assert.equal(error.code, "parser-failure");
                assert.equal(error.cause, cause);
                assert.doesNotMatch(error.message, /const first/);
                return true;
            },
        );
    });

    it("returns structured cancellation before and during parsing", async () => {
        const controller = new AbortController();
        const fakeParser = parser("typescript-parser");
        const registry = new ParserRegistry([fakeParser]);
        controller.abort("cancel before parse");

        await assert.rejects(
            registry.parse(document(), { signal: controller.signal }),
            (error: unknown) => expectChunkingError(error, "cancelled"),
        );
        assert.equal(fakeParser.parseCount, 0);

        const activeController = new AbortController();
        const cancellingParser = new FakeParser(
            "cancelling-parser",
            [{ language: "typescript" }],
            (_sourceDocument, options) => {
                activeController.abort("cancel during parse");
                options.signal?.throwIfAborted();
                throw new Error("unreachable");
            },
        );
        const activeRegistry = new ParserRegistry([cancellingParser]);

        await assert.rejects(
            activeRegistry.parse(document(), {
                signal: activeController.signal,
            }),
            (error: unknown) => expectChunkingError(error, "cancelled"),
        );
    });

    it("rejects roots that do not cover the complete document", async () => {
        const incompleteParser = new FakeParser(
            "incomplete-parser",
            [{ language: "typescript" }],
            (sourceDocument) => {
                const sourcePositions = new SourcePositionIndex(
                    sourceDocument.content,
                );

                return {
                    parserId: "incomplete-parser",
                    root: {
                        type: "program",
                        range: sourcePositions.createRange(
                            0,
                            sourceDocument.content.length - 1,
                        ),
                        children: [],
                    },
                };
            },
        );

        await assert.rejects(
            new ParserRegistry([incompleteParser]).parse(document()),
            (error: unknown) =>
                expectChunkingError(error, "invalid-syntax-tree"),
        );
    });

    it("rejects overlapping children and parser identity mismatches", async () => {
        const overlappingParser = new FakeParser(
            "overlapping-parser",
            [{ language: "typescript" }],
            (sourceDocument) => {
                const sourcePositions = new SourcePositionIndex(
                    sourceDocument.content,
                );
                const children: SyntaxNode[] = [
                    {
                        type: "first",
                        range: sourcePositions.createRange(0, 10),
                        children: [],
                    },
                    {
                        type: "second",
                        range: sourcePositions.createRange(8, 20),
                        children: [],
                    },
                ];

                return treeFor(
                    sourceDocument,
                    "overlapping-parser",
                    children,
                );
            },
        );
        const wrongIdentityParser = new FakeParser(
            "identity-parser",
            [{ language: "python" }],
            (sourceDocument) => treeFor(sourceDocument, "another-parser"),
        );

        await assert.rejects(
            new ParserRegistry([overlappingParser]).parse(document()),
            (error: unknown) =>
                expectChunkingError(error, "invalid-syntax-tree"),
        );
        await assert.rejects(
            new ParserRegistry([wrongIdentityParser]).parse(
                document({ language: "python", format: "python" }),
            ),
            (error: unknown) =>
                expectChunkingError(error, "invalid-syntax-tree"),
        );
    });

    it("rejects cyclic normalized trees", async () => {
        const cyclicParser = new FakeParser(
            "cyclic-parser",
            [{ language: "typescript" }],
            (sourceDocument) => {
                const sourcePositions = new SourcePositionIndex(
                    sourceDocument.content,
                );
                const children: SyntaxNode[] = [];
                const root: SyntaxNode = {
                    type: "program",
                    range: sourcePositions.createRange(
                        0,
                        sourceDocument.content.length,
                    ),
                    children,
                };
                children.push(root);

                return { parserId: "cyclic-parser", root };
            },
        );

        await assert.rejects(
            new ParserRegistry([cyclicParser]).parse(document()),
            (error: unknown) =>
                expectChunkingError(error, "invalid-syntax-tree"),
        );
    });
});
