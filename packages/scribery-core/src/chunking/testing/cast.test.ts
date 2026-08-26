import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SourcePositionIndex } from "../../metadata/index.js";
import {
    CastChunkingStrategy,
    CHUNK_SIZE_UNIT,
    ChunkingError,
    createInitialParserRegistry,
    ParserRegistry,
} from "../index.js";
import type {
    Chunk,
    ChunkingDocument,
    ChunkingOptions,
    SyntaxNode,
} from "../index.js";
import { FakeParser } from "./fake-parser.js";

function document(
    overrides: Partial<ChunkingDocument> = {},
): ChunkingDocument {
    return {
        path: "src/example.ts",
        content: "export const answer = 42;\n",
        language: "typescript",
        format: "typescript",
        ...overrides,
    };
}

function options(
    maximumSize: number,
    signal?: AbortSignal,
): ChunkingOptions {
    return {
        maximumSize,
        sizeUnit: CHUNK_SIZE_UNIT.UTF_16_CODE_UNITS,
        ...(signal === undefined ? {} : { signal }),
    };
}

function syntaxNode(
    sourcePositions: SourcePositionIndex,
    type: string,
    startOffset: number,
    endOffset: number,
    children: readonly SyntaxNode[] = [],
): SyntaxNode {
    return {
        type,
        range: sourcePositions.createRange(startOffset, endOffset),
        children,
    };
}

function fakeParserFor(
    createRoot: (
        sourcePositions: SourcePositionIndex,
        sourceDocument: ChunkingDocument,
    ) => SyntaxNode,
): FakeParser {
    return new FakeParser(
        "fixture-parser",
        [{ language: "typescript", format: "typescript" }],
        (sourceDocument) => {
            const sourcePositions = new SourcePositionIndex(
                sourceDocument.content,
            );

            return {
                parserId: "fixture-parser",
                root: createRoot(sourcePositions, sourceDocument),
            };
        },
    );
}

function assertExactCoverage(
    sourceDocument: ChunkingDocument,
    chunks: readonly Chunk[],
): void {
    let expectedStartOffset = 0;

    for (const chunk of chunks) {
        assert.equal(chunk.strategy, "cast");
        assert.equal(chunk.range.startOffset, expectedStartOffset);
        assert.equal(
            chunk.content,
            sourceDocument.content.slice(
                chunk.range.startOffset,
                chunk.range.endOffset,
            ),
        );
        expectedStartOffset = chunk.range.endOffset;
    }

    assert.equal(expectedStartOffset, sourceDocument.content.length);
    assert.equal(
        chunks.map((chunk) => chunk.content).join(""),
        sourceDocument.content,
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

describe("CastChunkingStrategy", () => {
    it("keeps a complete source file when it fits the size limit", async () => {
        const sourceDocument = document();
        const strategy = new CastChunkingStrategy(
            createInitialParserRegistry(),
        );
        const chunks = await strategy.chunk(
            sourceDocument,
            options(sourceDocument.content.length),
        );

        assert.equal(strategy.id, "cast");
        assert.deepEqual(chunks, [
            {
                content: sourceDocument.content,
                range: {
                    startOffset: 0,
                    endOffset: sourceDocument.content.length,
                    startLine: 1,
                    endLine: 1,
                },
                strategy: "cast",
                kind: "SourceFile",
            },
        ]);
    });

    it("recursively splits oversized nodes and greedily merges small siblings", async () => {
        const sourceDocument = document({
            content: "012345678901234567890123456789",
        });
        const parser = fakeParserFor((sourcePositions) => {
            const bigChildren = [
                syntaxNode(sourcePositions, "A", 5, 9),
                syntaxNode(sourcePositions, "B", 9, 13),
                syntaxNode(sourcePositions, "C", 13, 21),
                syntaxNode(sourcePositions, "D", 21, 25),
            ];
            const children = [
                syntaxNode(sourcePositions, "Before", 0, 5),
                syntaxNode(sourcePositions, "Big", 5, 25, bigChildren),
                syntaxNode(sourcePositions, "After", 25, 30),
            ];

            return syntaxNode(sourcePositions, "Root", 0, 30, children);
        });
        const strategy = new CastChunkingStrategy(
            new ParserRegistry([parser]),
        );
        const chunks = await strategy.chunk(sourceDocument, options(10));
        const repeatedChunks = await strategy.chunk(
            sourceDocument,
            options(10),
        );

        assert.deepEqual(
            chunks.map(({ range, kind }) => ({
                startOffset: range.startOffset,
                endOffset: range.endOffset,
                ...(kind === undefined ? {} : { kind }),
            })),
            [
                { startOffset: 0, endOffset: 5, kind: "Before" },
                { startOffset: 5, endOffset: 13 },
                { startOffset: 13, endOffset: 21, kind: "C" },
                { startOffset: 21, endOffset: 25, kind: "D" },
                { startOffset: 25, endOffset: 30, kind: "After" },
            ],
        );
        assertExactCoverage(sourceDocument, chunks);
        assert.deepEqual(repeatedChunks, chunks);
    });

    it("carries a dangling prefix into an oversized child before splitting it", async () => {
        const sourceDocument = document({
            content: "call(AAAAABBBBBCCCCCDDDDDEEEEEFFFFF)",
        });
        const parser = fakeParserFor((sourcePositions) =>
            syntaxNode(sourcePositions, "Root", 0, 36, [
                syntaxNode(sourcePositions, "Prefix", 0, 5),
                syntaxNode(sourcePositions, "Arguments", 5, 35, [
                    syntaxNode(sourcePositions, "A", 5, 10),
                    syntaxNode(sourcePositions, "B", 10, 15),
                    syntaxNode(sourcePositions, "C", 15, 20),
                    syntaxNode(sourcePositions, "D", 20, 25),
                    syntaxNode(sourcePositions, "E", 25, 30),
                    syntaxNode(sourcePositions, "F", 30, 35),
                ]),
                syntaxNode(sourcePositions, "Close", 35, 36),
            ])
        );
        const chunks = await new CastChunkingStrategy(
            new ParserRegistry([parser]),
        ).chunk(sourceDocument, options(25));

        assert.deepEqual(
            chunks.map(({ content }) => content),
            ["call(AAAAABBBBBCCCCCDDDDD", "EEEEEFFFFF)"],
        );
        assert.ok(chunks.every(({ content }) => content.length <= 25));
        assertExactCoverage(sourceDocument, chunks);
    });

    it("preserves comments, punctuation, whitespace, Unicode, and CRLF", async () => {
        const sourceDocument = document({
            path: "src/unicode.ts",
            content: [
                "// Привет 😀",
                "const first = 1;",
                "",
                "// Между объявлениями",
                "const second = 2;",
                "",
            ].join("\r\n"),
        });
        const chunks = await new CastChunkingStrategy(
            createInitialParserRegistry(),
        ).chunk(sourceDocument, options(45));

        assert.ok(chunks.length > 1);
        assert.ok(chunks.every((chunk) => chunk.content.length <= 45));
        assertExactCoverage(sourceDocument, chunks);

        const sourcePositions = new SourcePositionIndex(sourceDocument.content);

        for (const chunk of chunks) {
            sourcePositions.validateRange(chunk.range);
        }
    });

    it("falls back to bounded source splits for an oversized AST leaf", async () => {
        const sourceDocument = document({ content: "indivisible!" });
        const parser = fakeParserFor((sourcePositions, currentDocument) =>
            syntaxNode(
                sourcePositions,
                "Literal",
                0,
                currentDocument.content.length,
            ),
        );
        const chunks = await new CastChunkingStrategy(
            new ParserRegistry([parser]),
        ).chunk(sourceDocument, options(4));

        assert.deepEqual(
            chunks.map(({ content, kind }) => ({ content, kind })),
            [
                { content: "indi", kind: "Literal" },
                { content: "visi", kind: "Literal" },
                { content: "ble!", kind: "Literal" },
            ],
        );
        assert.ok(chunks.every(({ content }) => content.length <= 4));
        assertExactCoverage(sourceDocument, chunks);
    });

    it("prefers readable delimiters when splitting an oversized AST leaf", async () => {
        const sourceDocument = document({ content: "alpha;beta;gamma;" });
        const parser = fakeParserFor((sourcePositions, currentDocument) =>
            syntaxNode(
                sourcePositions,
                "Literal",
                0,
                currentDocument.content.length,
            ),
        );
        const chunks = await new CastChunkingStrategy(
            new ParserRegistry([parser]),
        ).chunk(sourceDocument, options(7));

        assert.deepEqual(
            chunks.map(({ content }) => content),
            ["alpha;", "beta;", "gamma;"],
        );
        assert.ok(chunks.every(({ content }) => content.length <= 7));
        assertExactCoverage(sourceDocument, chunks);
    });

    it("keeps structural residue out of forced semantic leaf splits", async () => {
        const sourceDocument = document({
            content: "<wrapper>\nABCDEFGHIJKLMNO\n</wrapper>",
        });
        const bodyStart = sourceDocument.content.indexOf("A");
        const bodyEnd = bodyStart + "ABCDEFGHIJKLMNO".length;
        const closingWhitespaceStart = bodyEnd;
        const parser = fakeParserFor((sourcePositions, currentDocument) =>
            syntaxNode(
                sourcePositions,
                "Root",
                0,
                currentDocument.content.length,
                [
                    syntaxNode(
                        sourcePositions,
                        "text",
                        "<wrapper>".length,
                        bodyStart,
                    ),
                    syntaxNode(
                        sourcePositions,
                        "Body",
                        bodyStart,
                        bodyEnd,
                    ),
                    syntaxNode(
                        sourcePositions,
                        "text",
                        closingWhitespaceStart,
                        closingWhitespaceStart + 1,
                    ),
                ],
            )
        );
        const chunks = await new CastChunkingStrategy(
            new ParserRegistry([parser]),
        ).chunk(sourceDocument, options(10));

        assert.deepEqual(
            chunks.map(({ content, searchable }) => ({
                content,
                ...(searchable === undefined ? {} : { searchable }),
            })),
            [
                { content: "<wrapper>\n", searchable: false },
                { content: "ABCDEFGHIJ" },
                { content: "KLMNO" },
                { content: "\n</wrapper>", searchable: false },
            ],
        );
        assert.ok(chunks
            .filter(({ searchable }) => searchable !== false)
            .every(({ content }) => content.length <= 10));
        assertExactCoverage(sourceDocument, chunks);
    });

    it("marks boundary residue non-searchable when neither neighbor can absorb it", async () => {
        const sourceDocument = document({
            content: "AAAAAAAAAA\nBBBBBBBBBB",
        });
        const parser = fakeParserFor((sourcePositions) =>
            syntaxNode(sourcePositions, "Root", 0, 21, [
                syntaxNode(sourcePositions, "First", 0, 10),
                syntaxNode(sourcePositions, "text", 10, 11),
                syntaxNode(sourcePositions, "Second", 11, 21),
            ])
        );
        const chunks = await new CastChunkingStrategy(
            new ParserRegistry([parser]),
        ).chunk(sourceDocument, options(10));

        assert.deepEqual(
            chunks.map(({ content, searchable }) => ({
                content,
                ...(searchable === undefined ? {} : { searchable }),
            })),
            [
                { content: "AAAAAAAAAA" },
                { content: "\n", searchable: false },
                { content: "BBBBBBBBBB" },
            ],
        );
        assertExactCoverage(sourceDocument, chunks);
    });

    it("rejects invalid size options before invoking a parser", async () => {
        const sourceDocument = document();
        const parser = fakeParserFor((sourcePositions, currentDocument) =>
            syntaxNode(
                sourcePositions,
                "Root",
                0,
                currentDocument.content.length,
            ),
        );
        const strategy = new CastChunkingStrategy(
            new ParserRegistry([parser]),
        );

        await assert.rejects(
            strategy.chunk(sourceDocument, options(0)),
            (error: unknown) => expectChunkingError(error, "invalid-options"),
        );
        await assert.rejects(
            strategy.chunk(sourceDocument, options(1.5)),
            (error: unknown) => expectChunkingError(error, "invalid-options"),
        );
        await assert.rejects(
            strategy.chunk(sourceDocument, {
                maximumSize: 10,
                sizeUnit: "bytes",
            } as unknown as ChunkingOptions),
            (error: unknown) => expectChunkingError(error, "invalid-options"),
        );
        assert.equal(parser.parseCount, 0);
    });

    it("propagates unsupported-parser and parser-failure diagnostics", async () => {
        const strategy = new CastChunkingStrategy(
            createInitialParserRegistry(),
        );

        await assert.rejects(
            strategy.chunk(
                document({
                    path: "src/Example.cs",
                    content: "class Example {}\n",
                    language: "c-sharp",
                    format: "c-sharp",
                }),
                options(100),
            ),
            (error: unknown) =>
                expectChunkingError(error, "unsupported-parser"),
        );
        await assert.rejects(
            strategy.chunk(
                document({ content: "function broken( {" }),
                options(100),
            ),
            (error: unknown) =>
                expectChunkingError(error, "parser-failure"),
        );
    });

    it("supports cancellation before parsing and during tree traversal", async () => {
        const sourceDocument = document({ content: "01234567890123456789" });
        const parser = fakeParserFor((sourcePositions) =>
            syntaxNode(sourcePositions, "Root", 0, 20, [
                syntaxNode(sourcePositions, "A", 0, 4),
                syntaxNode(sourcePositions, "B", 4, 8),
                syntaxNode(sourcePositions, "C", 8, 12),
                syntaxNode(sourcePositions, "D", 12, 16),
                syntaxNode(sourcePositions, "E", 16, 20),
            ]),
        );
        const strategy = new CastChunkingStrategy(
            new ParserRegistry([parser]),
        );
        const controller = new AbortController();
        controller.abort("cancel before parsing");

        await assert.rejects(
            strategy.chunk(sourceDocument, options(5, controller.signal)),
            (error: unknown) => expectChunkingError(error, "cancelled"),
        );
        assert.equal(parser.parseCount, 0);

        let cancellationChecks = 0;
        const traversalSignal = {
            get aborted() {
                cancellationChecks += 1;
                return cancellationChecks >= 6;
            },
            reason: "cancel during traversal",
        } as unknown as AbortSignal;

        await assert.rejects(
            strategy.chunk(sourceDocument, options(5, traversalSignal)),
            (error: unknown) => expectChunkingError(error, "cancelled"),
        );
        assert.equal(parser.parseCount, 1);
        assert.ok(cancellationChecks >= 6);
    });
});
