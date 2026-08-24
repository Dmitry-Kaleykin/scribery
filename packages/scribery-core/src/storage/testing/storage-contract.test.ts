import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

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
} from "../index.js";

const model: EmbeddingModelIdentity = {
    provider: "fixture",
    model: "fixture-v1",
    dimensions: 3,
    metric: "cosine",
};

describe("storage provider contract", () => {
    for (const providerName of ["memory", "sqlite"] as const) {
        it(`${providerName} hides building records and enforces search scope`, async () => {
            const { storage, reopen } = await createProvider(providerName);
            const repositoryId = "repository_fixture";
            const snapshotId = "snapshot_fixture";
            const indexBuildId = `index-build_${providerName}`;
            const content = "export const answer = 42;\n";
            const contentHash = hashText(content);
            const fileRevisionId = createFileRevisionId(contentHash);
            const documentId = createDocumentId(repositoryId, ".", "src/example.ts");
            const duplicateDocumentId = createDocumentId(
                repositoryId,
                ".",
                "src/duplicate.ts",
            );
            const chunkId = createChunkId({
                fileRevisionId,
                chunkingIdentity: "cast-v1:100",
                range: {
                    startOffset: 0,
                    endOffset: content.length,
                    startLine: 1,
                    endLine: 1,
                },
                contentHash,
            });
            const vector = Float32Array.of(1, 0, 0);
            const inputHash = hashText("formatted input");
            const embeddingId = createEmbeddingId(inputHash, model);
            const configurationHash = hashText("configuration");
            const artifactCompatibilityHash = hashText("artifact-compatibility");
            const artifactRequest = {
                encoding: "utf-8" as const,
                language: "typescript",
                format: "typescript",
                parserId: "fixture-parser-v1",
                chunkingIdentity: "cast-v1:100",
            };

            await storage.beginBuild({
                indexBuildId,
                repositoryId,
                snapshotId,
                sourceIdentity: "fixture-source",
                sourceProvenance: {
                    kind: "directory",
                    root: "/fixture",
                },
                configurationHash,
                artifactCompatibilityHash,
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
                    path: "src/example.ts",
                    filename: "example.ts",
                    extension: "ts",
                    byteLength: content.length,
                    byteContentHash: contentHash,
                    decodedContentHash: contentHash,
                    contentKind: "text",
                    format: "typescript",
                    language: "typescript",
                    parserId: artifactRequest.parserId,
                    encoding: "utf-8",
                    traits: [],
                    classificationConfidence: 1,
                },
            });
            await storage.putDocument(indexBuildId, {
                content,
                metadata: {
                    schemaVersion: METADATA_SCHEMA_VERSION,
                    documentId: duplicateDocumentId,
                    fileRevisionId,
                    path: "src/duplicate.ts",
                    filename: "duplicate.ts",
                    extension: "ts",
                    byteLength: content.length,
                    byteContentHash: contentHash,
                    decodedContentHash: contentHash,
                    contentKind: "text",
                    format: "typescript",
                    language: "typescript",
                    parserId: artifactRequest.parserId,
                    encoding: "utf-8",
                    traits: [],
                    classificationConfidence: 1,
                },
            });
            await storage.putChunkEmbeddings(indexBuildId, [
                {
                    documentId,
                    chunk: {
                        content,
                        metadata: {
                            schemaVersion: METADATA_SCHEMA_VERSION,
                            chunkId,
                            fileRevisionId,
                            documentId,
                            index: 0,
                            contentHash,
                            startOffset: 0,
                            endOffset: content.length,
                            startLine: 1,
                            endLine: 1,
                            chunkingStrategy: "cast",
                            chunkingIdentity: "cast-v1:100",
                        },
                    },
                    embedding: {
                        embeddingId,
                        inputHash,
                        modelIdentity: model,
                        vector,
                    },
                    filterMetadata: {
                        path: "src/example.ts",
                        language: "typescript",
                    },
                },
                {
                    documentId: duplicateDocumentId,
                    chunk: {
                        content,
                        metadata: {
                            schemaVersion: METADATA_SCHEMA_VERSION,
                            chunkId,
                            fileRevisionId,
                            documentId: duplicateDocumentId,
                            index: 0,
                            contentHash,
                            startOffset: 0,
                            endOffset: content.length,
                            startLine: 1,
                            endLine: 1,
                            chunkingStrategy: "cast",
                            chunkingIdentity: "cast-v1:100",
                        },
                    },
                    embedding: {
                        embeddingId,
                        inputHash,
                        modelIdentity: model,
                        vector,
                    },
                    filterMetadata: {
                        path: "src/duplicate.ts",
                        language: "typescript",
                    },
                },
            ]);

            const request = {
                repositoryId,
                snapshotId,
                indexBuildId,
                vector,
                modelIdentity: model,
                limit: 5,
            };
            assert.deepEqual(await storage.vectorSearch(request), []);

            await storage.setBuildStatus(
                indexBuildId,
                "ready",
                new Date(1).toISOString(),
            );
            const builds = await storage.listBuilds();
            assert.equal(builds.length, 1);
            assert.equal(builds[0]?.indexBuildId, indexBuildId);
            assert.equal(builds[0]?.status, "ready");
            assert.deepEqual(builds[0]?.sourceProvenance, {
                kind: "directory",
                root: "/fixture",
            });
            const documentChunks = await storage.getDocumentChunks({
                indexBuildId,
                path: "src/example.ts",
            });
            assert.equal(documentChunks?.document.metadata.documentId, documentId);
            assert.equal(documentChunks?.chunks.length, 1);
            assert.equal(documentChunks?.chunks[0]?.content, content);
            const results = await storage.vectorSearch(request);
            assert.equal(results.length, 2);
            assert.ok(results.every(({ chunk }) => chunk.metadata.chunkId === chunkId));
            assert.ok(results.every(({ chunk, document }) =>
                chunk.metadata.documentId === document.metadata.documentId
            ));
            assert.deepEqual(
                new Set(results.map(({ document }) => document.metadata.path)),
                new Set(["src/example.ts", "src/duplicate.ts"]),
            );
            assert.equal((await storage.vectorSearch({
                ...request,
                modelIdentity: {
                    metric: "cosine",
                    dimensions: 3,
                    model: "fixture-v1",
                    provider: "fixture",
                },
            })).length, 2);
            await assert.rejects(storage.vectorSearch({
                ...request,
                filters: [{
                    field: "unrestricted_internal_field",
                    operator: "equals",
                    value: "no",
                }],
            } as unknown as Parameters<StorageProvider["vectorSearch"]>[0]));
            assert.deepEqual(
                await storage.vectorSearch({ ...request, snapshotId: "wrong" }),
                [],
            );
            assert.deepEqual(
                await storage.vectorSearch({ ...request, indexBuildId: "wrong" }),
                [],
            );

            const reusedIndexBuildId = `${indexBuildId}_reused`;
            const reusedSnapshotId = `${snapshotId}_reused`;
            await storage.beginBuild({
                indexBuildId: reusedIndexBuildId,
                repositoryId,
                snapshotId: reusedSnapshotId,
                sourceIdentity: "fixture-source-reused",
                configurationHash,
                artifactCompatibilityHash,
                modelIdentity: model,
                status: "building",
                createdAt: new Date(2).toISOString(),
            });
            assert.equal(await storage.reuseDocumentArtifacts({
                targetIndexBuildId: reusedIndexBuildId,
                documentId,
                fileRevisionId: "file-revision_wrong",
                ...artifactRequest,
            }), undefined);
            assert.equal(await storage.reuseDocumentArtifacts({
                targetIndexBuildId: reusedIndexBuildId,
                documentId,
                fileRevisionId,
                ...artifactRequest,
                encoding: "windows-1251",
            }), undefined);
            assert.equal(await storage.reuseDocumentArtifacts({
                targetIndexBuildId: reusedIndexBuildId,
                documentId,
                fileRevisionId,
                ...artifactRequest,
                parserId: "fixture-parser-v2",
            }), undefined);
            assert.equal(await storage.reuseDocumentArtifacts({
                targetIndexBuildId: reusedIndexBuildId,
                documentId,
                fileRevisionId,
                ...artifactRequest,
                chunkingIdentity: "cast-v2:100",
            }), undefined);
            const bulkReused = await storage.reuseDocumentArtifactsMany({
                targetIndexBuildId: reusedIndexBuildId,
                candidates: [
                    {
                        documentId,
                        fileRevisionId,
                        compatibleEncodings: ["utf-8", "windows-1251"],
                        language: artifactRequest.language,
                        format: artifactRequest.format,
                        parserId: artifactRequest.parserId,
                        chunkingIdentity: artifactRequest.chunkingIdentity,
                    },
                    {
                        documentId: duplicateDocumentId,
                        fileRevisionId,
                        compatibleEncodings: ["utf-8"],
                        language: artifactRequest.language,
                        format: artifactRequest.format,
                        parserId: artifactRequest.parserId,
                        chunkingIdentity: artifactRequest.chunkingIdentity,
                    },
                ],
            });
            assert.deepEqual(
                bulkReused.map(({ documentId: reusedId, chunkCount }) => ({
                    documentId: reusedId,
                    chunkCount,
                })),
                [
                    { documentId, chunkCount: 1 },
                    { documentId: duplicateDocumentId, chunkCount: 1 },
                ],
            );
            await storage.setBuildStatus(
                reusedIndexBuildId,
                "ready",
                new Date(3).toISOString(),
            );
            const reusedRequest = {
                ...request,
                snapshotId: reusedSnapshotId,
                indexBuildId: reusedIndexBuildId,
            };
            assert.equal((await storage.vectorSearch(reusedRequest)).length, 2);

            const variedConfigurationBuildId = `${indexBuildId}_configuration`;
            await storage.beginBuild({
                indexBuildId: variedConfigurationBuildId,
                repositoryId,
                snapshotId: `${snapshotId}_configuration`,
                sourceIdentity: "fixture-source-configuration",
                configurationHash: hashText("incompatible-configuration"),
                artifactCompatibilityHash,
                modelIdentity: model,
                status: "building",
                createdAt: new Date(4).toISOString(),
            });
            assert.equal((await storage.reuseDocumentArtifacts({
                targetIndexBuildId: variedConfigurationBuildId,
                documentId,
                fileRevisionId,
                ...artifactRequest,
            }))?.chunkCount, 1);
            await storage.setBuildStatus(
                variedConfigurationBuildId,
                "cancelled",
                new Date(5).toISOString(),
            );

            const incompatibleArtifactBuildId = `${indexBuildId}_artifact`;
            await storage.beginBuild({
                indexBuildId: incompatibleArtifactBuildId,
                repositoryId,
                snapshotId: `${snapshotId}_artifact`,
                sourceIdentity: "fixture-source-artifact",
                configurationHash,
                artifactCompatibilityHash: hashText("incompatible-artifact"),
                modelIdentity: model,
                status: "building",
                createdAt: new Date(6).toISOString(),
            });
            assert.equal(await storage.reuseDocumentArtifacts({
                targetIndexBuildId: incompatibleArtifactBuildId,
                documentId,
                fileRevisionId,
                ...artifactRequest,
            }), undefined);
            assert.ok(documentChunks);
            await storage.putDocument(
                incompatibleArtifactBuildId,
                documentChunks.document,
            );
            assert.equal((await storage.reuseChunkEmbeddings(
                incompatibleArtifactBuildId,
                [{
                    documentId,
                    chunk: documentChunks.chunks[0]!,
                    embeddingId,
                    inputHash,
                    filterMetadata: {
                        path: "src/example.ts",
                        language: "typescript",
                    },
                }],
            )).length, 1);
            await storage.setBuildStatus(
                incompatibleArtifactBuildId,
                "cancelled",
                new Date(7).toISOString(),
            );

            const incompatibleModelIndexBuildId = `${indexBuildId}_model`;
            await storage.beginBuild({
                indexBuildId: incompatibleModelIndexBuildId,
                repositoryId,
                snapshotId: `${snapshotId}_model`,
                sourceIdentity: "fixture-source-model",
                configurationHash,
                artifactCompatibilityHash,
                modelIdentity: { ...model, model: "fixture-v2" },
                status: "building",
                createdAt: new Date(8).toISOString(),
            });
            assert.equal(await storage.reuseDocumentArtifacts({
                targetIndexBuildId: incompatibleModelIndexBuildId,
                documentId,
                fileRevisionId,
                ...artifactRequest,
            }), undefined);
            await storage.setBuildStatus(
                incompatibleModelIndexBuildId,
                "cancelled",
                new Date(9).toISOString(),
            );

            await storage.close();

            if (reopen !== undefined) {
                const reopened = reopen();

                try {
                    const persistedResults = await reopened.vectorSearch(request);
                    assert.equal(persistedResults.length, 2);
                    assert.ok(persistedResults.every(({ chunk, document }) =>
                        chunk.metadata.documentId === document.metadata.documentId
                    ));
                    assert.equal(
                        (await reopened.vectorSearch(reusedRequest)).length,
                        2,
                    );
                } finally {
                    await reopened.close();
                }
            }
        });

        it(`${providerName} deletes builds without removing shared artifacts`, async () => {
            const { storage } = await createProvider(providerName);
            const repositoryId = "repository_deletion";
            const content = "export const retained = true;\n";
            const contentHash = hashText(content);
            const fileRevisionId = createFileRevisionId(contentHash);
            const documentId = createDocumentId(
                repositoryId,
                ".",
                "src/retained.ts",
            );
            const chunkingIdentity = "cast-v1:100";
            const chunkId = createChunkId({
                fileRevisionId,
                chunkingIdentity,
                range: {
                    startOffset: 0,
                    endOffset: content.length,
                    startLine: 1,
                    endLine: 1,
                },
                contentHash,
            });
            const vector = Float32Array.of(1, 0, 0);
            const inputHash = hashText("retained input");
            const embeddingId = createEmbeddingId(inputHash, model);
            const firstBuildId = "index-build_delete_first";
            const secondBuildId = "index-build_delete_second";
            const artifactCompatibilityHash = hashText("deletion-artifacts");
            const configurationHash = hashText("deletion-configuration");
            const artifactRequest = {
                encoding: "utf-8" as const,
                language: "typescript",
                format: "typescript",
                parserId: "fixture-parser-v1",
                chunkingIdentity,
            };

            try {
                await storage.beginBuild({
                    indexBuildId: firstBuildId,
                    repositoryId,
                    snapshotId: "snapshot_delete_first",
                    sourceIdentity: "fixture-delete-first",
                    configurationHash,
                    artifactCompatibilityHash,
                    modelIdentity: model,
                    status: "building",
                    createdAt: new Date(0).toISOString(),
                });
                await storage.putDocument(firstBuildId, {
                    content,
                    metadata: {
                        schemaVersion: METADATA_SCHEMA_VERSION,
                        documentId,
                        fileRevisionId,
                        path: "src/retained.ts",
                        filename: "retained.ts",
                        extension: "ts",
                        byteLength: content.length,
                        byteContentHash: contentHash,
                        decodedContentHash: contentHash,
                        contentKind: "text",
                        format: "typescript",
                        language: "typescript",
                        parserId: artifactRequest.parserId,
                        encoding: "utf-8",
                        traits: [],
                        classificationConfidence: 1,
                    },
                });
                await storage.putChunkEmbeddings(firstBuildId, [{
                    documentId,
                    chunk: {
                        content,
                        metadata: {
                            schemaVersion: METADATA_SCHEMA_VERSION,
                            chunkId,
                            fileRevisionId,
                            documentId,
                            index: 0,
                            contentHash,
                            startOffset: 0,
                            endOffset: content.length,
                            startLine: 1,
                            endLine: 1,
                            chunkingStrategy: "cast",
                            chunkingIdentity,
                        },
                    },
                    embedding: {
                        embeddingId,
                        inputHash,
                        modelIdentity: model,
                        vector,
                    },
                    filterMetadata: {
                        path: "src/retained.ts",
                        language: "typescript",
                    },
                }]);
                await storage.setBuildStatus(
                    firstBuildId,
                    "ready",
                    new Date(1).toISOString(),
                );

                await storage.beginBuild({
                    indexBuildId: secondBuildId,
                    repositoryId,
                    snapshotId: "snapshot_delete_second",
                    sourceIdentity: "fixture-delete-second",
                    configurationHash,
                    artifactCompatibilityHash,
                    modelIdentity: model,
                    status: "building",
                    createdAt: new Date(2).toISOString(),
                });
                assert.equal((await storage.reuseDocumentArtifacts({
                    targetIndexBuildId: secondBuildId,
                    documentId,
                    fileRevisionId,
                    ...artifactRequest,
                }))?.chunkCount, 1);
                await storage.setBuildStatus(
                    secondBuildId,
                    "ready",
                    new Date(3).toISOString(),
                );

                const firstDeletion = await storage.deleteBuild(firstBuildId);
                assert.equal(firstDeletion.deletedDocuments, 1);
                assert.equal(firstDeletion.deletedMemberships, 1);
                assert.equal(firstDeletion.deletedChunks, 0);
                assert.equal(firstDeletion.deletedEmbeddings, 0);
                assert.equal((await storage.vectorSearch({
                    repositoryId,
                    snapshotId: "snapshot_delete_second",
                    indexBuildId: secondBuildId,
                    vector,
                    modelIdentity: model,
                    limit: 1,
                })).length, 1);

                const secondDeletion = await storage.deleteBuild(secondBuildId);
                assert.equal(secondDeletion.deletedChunks, 1);
                assert.equal(secondDeletion.deletedEmbeddings, 1);
                assert.deepEqual(await storage.listBuilds(), []);
            } finally {
                await storage.close();
            }
        });
    }

    it("migrates an existing SQLite build table for artifact compatibility", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-migration-"));
        const path = join(directory, "index.sqlite");
        const legacy = new DatabaseSync(path);
        legacy.exec(`
            CREATE TABLE builds (
                index_build_id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                snapshot_id TEXT NOT NULL,
                source_identity TEXT NOT NULL,
                configuration_hash TEXT NOT NULL,
                model_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                completed_at TEXT
            );
        `);
        legacy.close();

        const storage = new SqliteStorageProvider(path);

        try {
            await storage.beginBuild({
                indexBuildId: "index-build_migrated",
                repositoryId: "repository_migrated",
                snapshotId: "snapshot_migrated",
                sourceIdentity: "source-migrated",
                sourceProvenance: {
                    kind: "directory",
                    root: "/migrated",
                },
                configurationHash: hashText("configuration"),
                artifactCompatibilityHash: hashText("artifact"),
                modelIdentity: model,
                status: "building",
                createdAt: new Date(0).toISOString(),
            });
            assert.equal(
                (await storage.getBuild("index-build_migrated"))
                    ?.artifactCompatibilityHash,
                hashText("artifact"),
            );
            assert.deepEqual(
                (await storage.getBuild("index-build_migrated"))
                    ?.sourceProvenance,
                { kind: "directory", root: "/migrated" },
            );
        } finally {
            await storage.close();
        }
    });
});

async function createProvider(
    name: "memory" | "sqlite",
): Promise<{
    storage: StorageProvider;
    reopen?: () => StorageProvider;
}> {
    if (name === "memory") return { storage: new InMemoryStorageProvider() };
    const directory = await mkdtemp(join(tmpdir(), "scribery-storage-"));
    const path = join(directory, "index.sqlite");
    return {
        storage: new SqliteStorageProvider(path),
        reopen: () => new SqliteStorageProvider(path),
    };
}
