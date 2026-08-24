import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
    EmbeddingInput,
    EmbeddingProvider,
    EmbeddingResult,
} from "../../embeddings/index.js";
import {
    METADATA_SCHEMA_VERSION,
    createChunkId,
    createDocumentId,
    createEmbeddingId,
    createFileRevisionId,
    hashText,
    type EmbeddingModelIdentity,
} from "../../metadata/index.js";
import {
    InMemoryStorageProvider,
    SqliteStorageProvider,
    type StorageProvider,
} from "../../storage/index.js";
import { RetrievalError, SemanticRetriever } from "../index.js";

const model: EmbeddingModelIdentity = {
    provider: "context-fixture",
    model: "static-v1",
    dimensions: 2,
    metric: "cosine",
};

const repositoryId = "repository_context";
const snapshotId = "snapshot_context";

describe("retrieval context expansion", () => {
    for (const providerName of ["memory", "sqlite"] as const) {
        it(`${providerName} expands bounded neighbors within the exact build`, async () => {
            const storage = await createProvider(providerName);

            try {
                const fixture = await storeFixture(storage, providerName);
                const retriever = new SemanticRetriever(
                    storage,
                    new StaticQueryEmbeddingProvider(),
                );
                const [plainResult] = await retriever.retrieve({
                    repositoryId,
                    snapshotId,
                    indexBuildId: fixture.indexBuildId,
                    query: "target",
                    limit: 1,
                });

                assert.ok(plainResult !== undefined);
                assert.equal(plainResult.chunkId, fixture.chunkIds[1]);
                assert.equal(plainResult.context, undefined);

                const [expandedResult] = await retriever.retrieve({
                    repositoryId,
                    snapshotId,
                    indexBuildId: fixture.indexBuildId,
                    query: "target",
                    limit: 1,
                    context: {
                        beforeChunks: 2,
                        afterChunks: 2,
                        maximumCharacters: 1_000,
                    },
                });

                assert.ok(expandedResult?.context !== undefined);
                assert.deepEqual(
                    expandedResult.context.before.map(({ index }) => index),
                    [0],
                );
                assert.deepEqual(
                    expandedResult.context.after.map(({ index }) => index),
                    [2, 3],
                );
                assert.deepEqual(
                    expandedResult.context.before[0]?.range,
                    fixture.ranges[0],
                );
                assert.deepEqual(
                    expandedResult.context.after[0]?.range,
                    fixture.ranges[2],
                );

                const [budgetedResult] = await retriever.retrieve({
                    repositoryId,
                    snapshotId,
                    indexBuildId: fixture.indexBuildId,
                    query: "target",
                    limit: 1,
                    context: {
                        beforeChunks: 2,
                        afterChunks: 2,
                        maximumCharacters: fixture.contents[0]?.length ?? 1,
                    },
                });
                const budgetedChunks = [
                    ...(budgetedResult?.context?.before ?? []),
                    ...(budgetedResult?.context?.after ?? []),
                ];

                assert.equal(budgetedChunks.length, 1);
                assert.ok(
                    budgetedChunks.reduce(
                        (total, chunk) => total + chunk.content.length,
                        0,
                    ) <= (fixture.contents[0]?.length ?? 1),
                );

                const adjacentPrimaryResults = await retriever.retrieve({
                    repositoryId,
                    snapshotId,
                    indexBuildId: fixture.indexBuildId,
                    query: "target",
                    limit: 2,
                    context: {
                        beforeChunks: 2,
                        afterChunks: 2,
                        maximumCharacters: 1_000,
                    },
                });
                const primaryChunkIds = new Set(
                    adjacentPrimaryResults.map(({ chunkId }) => chunkId),
                );

                assert.equal(adjacentPrimaryResults.length, 2);
                assert.ok(adjacentPrimaryResults.every(({ context }) =>
                    [...(context?.before ?? []), ...(context?.after ?? [])]
                        .every(({ chunkId }) => !primaryChunkIds.has(chunkId))
                ));

                assert.deepEqual(await storage.getChunkNeighborhood({
                    repositoryId,
                    snapshotId: "snapshot_wrong",
                    indexBuildId: fixture.indexBuildId,
                    documentId: fixture.documentId,
                    anchorChunkId: fixture.chunkIds[1] ?? "missing",
                    beforeChunks: 2,
                    afterChunks: 2,
                }), { before: [], after: [] });

                await assert.rejects(
                    retriever.retrieve({
                        repositoryId,
                        snapshotId,
                        indexBuildId: fixture.indexBuildId,
                        query: "target",
                        context: { beforeChunks: 0, afterChunks: 0 },
                    }),
                    (error: unknown) =>
                        error instanceof RetrievalError &&
                        error.code === "invalid-request",
                );
            } finally {
                await storage.close();
            }
        });
    }
});

async function createProvider(
    name: "memory" | "sqlite",
): Promise<StorageProvider> {
    if (name === "memory") return new InMemoryStorageProvider();
    const directory = await mkdtemp(join(tmpdir(), "scribery-context-"));
    return new SqliteStorageProvider(join(directory, "index.sqlite"));
}

async function storeFixture(
    storage: StorageProvider,
    providerName: string,
): Promise<{
    indexBuildId: string;
    documentId: string;
    chunkIds: readonly string[];
    contents: readonly string[];
    ranges: readonly {
        startOffset: number;
        endOffset: number;
        startLine: number;
        endLine: number;
    }[];
}> {
    const indexBuildId = `index-build_context_${providerName}`;
    const documentId = createDocumentId(repositoryId, ".", "src/context.ts");
    const contents = [
        "const zero = 0;\n",
        "const target = 1;\n",
        "const two = 2;\n",
        "const three = 3;\n",
    ];
    const content = contents.join("");
    const contentHash = hashText(content);
    const fileRevisionId = createFileRevisionId(contentHash);
    let offset = 0;
    const ranges = contents.map((chunkContent, index) => {
        const startOffset = offset;
        offset += chunkContent.length;
        return {
            startOffset,
            endOffset: offset,
            startLine: index + 1,
            endLine: index + 1,
        };
    });
    const chunkIds = contents.map((chunkContent, index) => createChunkId({
        fileRevisionId,
        chunkingIdentity: "cast-v1:20",
        range: ranges[index] ?? ranges[0]!,
        contentHash: hashText(chunkContent),
    }));

    await storage.beginBuild({
        indexBuildId,
        repositoryId,
        snapshotId,
        sourceIdentity: "context-fixture",
        configurationHash: hashText("context-configuration"),
        modelIdentity: model,
        status: "building",
        createdAt: new Date(0).toISOString(),
    });
    await storage.putDocument(indexBuildId, {
        content,
        metadata: {
            schemaVersion: METADATA_SCHEMA_VERSION,
            documentId,
            fileRevisionId,
            path: "src/context.ts",
            filename: "context.ts",
            extension: "ts",
            byteLength: content.length,
            byteContentHash: contentHash,
            decodedContentHash: contentHash,
            contentKind: "text",
            format: "typescript",
            language: "typescript",
            encoding: "utf-8",
            traits: [],
            classificationConfidence: 1,
        },
    });

    for (let index = 0; index < contents.length; index += 1) {
        const chunkContent = contents[index];
        const chunkId = chunkIds[index];
        const range = ranges[index];

        assert.ok(chunkContent !== undefined && chunkId !== undefined);
        assert.ok(range !== undefined);
        const inputHash = hashText(`formatted-${index}`);
        await storage.putChunkEmbedding(
            indexBuildId,
            documentId,
            {
                content: chunkContent,
                metadata: {
                    schemaVersion: METADATA_SCHEMA_VERSION,
                    chunkId,
                    fileRevisionId,
                    documentId,
                    index,
                    contentHash: hashText(chunkContent),
                    ...range,
                    chunkingStrategy: "cast",
                    chunkingIdentity: "cast-v1:20",
                    kind: "statement",
                },
            },
            {
                embeddingId: createEmbeddingId(inputHash, model),
                inputHash,
                modelIdentity: model,
                vector: index === 1
                    ? Float32Array.of(1, 0)
                    : index === 2
                        ? Float32Array.of(0.9, 0.1)
                        : Float32Array.of(0, 1),
            },
            {
                path: "src/context.ts",
                language: "typescript",
                chunkKind: "statement",
            },
        );
    }

    await storage.setBuildStatus(indexBuildId, "ready", new Date(1).toISOString());

    return { indexBuildId, documentId, chunkIds, contents, ranges };
}

class StaticQueryEmbeddingProvider implements EmbeddingProvider {
    readonly identity = model;
    readonly maximumInputs = 16;
    readonly maximumCharacters = 10_000;

    async embed(inputs: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]> {
        return inputs.map(({ id }) => ({
            id,
            vector: Float32Array.of(1, 0),
        }));
    }
}
