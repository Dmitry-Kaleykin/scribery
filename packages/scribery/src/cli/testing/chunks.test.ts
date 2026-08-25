import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DocumentChunks } from "scribery-core";
import {
    formatDocumentChunks,
    serializeDocumentChunks,
} from "../chunks/format-document-chunks.js";

describe("chunks CLI formatting", () => {
    it("renders exact multiline content with visible chunk boundaries", () => {
        const result = fixture();
        const output = formatDocumentChunks("build-fixture", result);

        assert.match(output, /^File: src\/example\.ts$/mu);
        assert.match(output, /^Chunks: 2$/mu);
        assert.match(
            output,
            /^--- Chunk 1\/2 \| index=0 \| kind=FunctionDeclaration \| scope=first \| lines=1-2 \| offsets=0-32 ---$/mu,
        );
        assert.match(output, /export function first\(\) \{\}\n\n--- Chunk 2\/2/u);
        assert.ok(output.endsWith("export const second = true;\n\n"));
    });

    it("preserves complete metadata in JSON output", () => {
        const result = fixture();
        const serialized = serializeDocumentChunks(
            "build-fixture",
            result,
        ) as {
            chunkCount: number;
            chunks: DocumentChunks["chunks"];
        };

        assert.equal(serialized.chunkCount, 2);
        assert.equal(serialized.chunks[0]?.metadata.chunkId, "chunk-first");
        assert.equal(serialized.chunks[1]?.content, "export const second = true;");
    });
});

function fixture(): DocumentChunks {
    return {
        document: {
            content: "export function first() {}\nexport const second = true;",
            metadata: {
                schemaVersion: 1,
                documentId: "document-fixture",
                fileRevisionId: "revision-fixture",
                path: "src/example.ts",
                filename: "example.ts",
                extension: "ts",
                byteLength: 60,
                byteContentHash: "byte-hash",
                decodedContentHash: "decoded-hash",
                contentKind: "text",
                format: "typescript",
                language: "typescript",
                encoding: "utf-8",
                traits: [],
                classificationConfidence: 1,
            },
        },
        chunks: [
            {
                content: "export function first() {}\n",
                metadata: {
                    schemaVersion: 1,
                    chunkId: "chunk-first",
                    fileRevisionId: "revision-fixture",
                    documentId: "document-fixture",
                    index: 0,
                    contentHash: "first-hash",
                    startOffset: 0,
                    endOffset: 32,
                    startLine: 1,
                    endLine: 2,
                    chunkingStrategy: "cast",
                    chunkingIdentity: "cast-v1:3000",
                    kind: "FunctionDeclaration",
                    semanticContext: {
                        scope: [{
                            name: "first",
                            kind: "function",
                            signature: "export function first()",
                        }],
                        symbols: [{
                            name: "first",
                            kind: "function",
                            signature: "export function first()",
                        }],
                        imports: [],
                    },
                },
            },
            {
                content: "export const second = true;",
                metadata: {
                    schemaVersion: 1,
                    chunkId: "chunk-second",
                    fileRevisionId: "revision-fixture",
                    documentId: "document-fixture",
                    index: 1,
                    contentHash: "second-hash",
                    startOffset: 32,
                    endOffset: 59,
                    startLine: 2,
                    endLine: 2,
                    chunkingStrategy: "cast",
                    chunkingIdentity: "cast-v1:3000",
                },
            },
        ],
    };
}
