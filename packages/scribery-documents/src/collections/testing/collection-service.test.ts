import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DeterministicFakeEmbeddingProvider } from "scribery-core";
import { SqliteStorageProvider } from "scribery-core";
import {
    collectionDirectory,
    CollectionError,
    CollectionService,
} from "../index.js";

describe("CollectionService", () => {
    it("manages, builds, and hard-scopes generic code and text sources", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-collection-"));

        try {
            const service = new CollectionService({
                embeddingProvider: new DeterministicFakeEmbeddingProvider(16),
                collectionsDirectory: directory,
            });
            const collection = await service.createCollection("Personal notes");
            await service.upsertDocuments(collection.collectionId, [
                {
                    externalId: "note:authentication",
                    logicalPath: "notes/authentication.txt",
                    title: "Authentication notes",
                    content: "Authentication uses a local signed session token. ".repeat(8),
                    tags: ["selected"],
                    attributes: {
                        conversationId: "chat-123",
                        role: "assistant",
                        ordinal: 17,
                    },
                },
                {
                    externalId: "code:example",
                    logicalPath: "examples/example.js",
                    title: "Example JavaScript",
                    content: "export function unrelated() { return 42; }\n",
                    mediaType: "text/javascript",
                    tags: ["other"],
                },
            ]);

            await assert.rejects(
                service.retrieve(collection.collectionId, { query: "session token" }),
                (error: unknown) => {
                    assert.ok(error instanceof CollectionError);
                    assert.equal(error.code, "build-required");
                    return true;
                },
            );

            const firstBuild = await service.buildCollection(collection.collectionId, {
                maximumChunkSize: 120,
                slidingWindowOverlap: 20,
            });
            assert.equal(firstBuild.sourceCount, 2);
            assert.equal(firstBuild.diagnostics.length, 0);
            assert.ok(firstBuild.indexedChunks > 2);

            const sources = await service.listSources(collection.collectionId);
            const note = sources.find(({ externalId }) =>
                externalId === "note:authentication"
            );
            const code = sources.find(({ externalId }) => externalId === "code:example");
            assert.ok(note);
            assert.ok(code);

            assert.deepEqual(
                await service.retrieve(collection.collectionId, {
                    query: "session token",
                    scope: { sourceIds: [] },
                }),
                [],
            );
            const scoped = await service.retrieve(collection.collectionId, {
                query: "session token",
                scope: { sourceIds: [note.sourceId] },
                limit: 5,
            });
            assert.ok(scoped.length > 0);
            assert.ok(scoped.every(({ sourceId }) => sourceId === note.sourceId));
            assert.equal(scoped[0]?.sourceTitle, "Authentication notes");
            assert.deepEqual(scoped[0]?.sourceAttributes, {
                conversationId: "chat-123",
                ordinal: 17,
                role: "assistant",
            });

            const tagged = await service.retrieve(collection.collectionId, {
                query: "session token",
                scope: { tags: ["selected"] },
                limit: 5,
            });
            assert.ok(tagged.length > 0);
            assert.ok(tagged.every(({ sourceId }) => sourceId === note.sourceId));

            const resolved = await service.resolveActiveBuild(collection.collectionId);
            const storage = new SqliteStorageProvider(resolved.databasePath, {
                readOnly: true,
                immutable: true,
            });
            const documentChunks = await storage.getDocumentChunks({
                indexBuildId: resolved.build.indexBuildId,
                path: note.logicalPath,
            });
            const codeChunks = await storage.getDocumentChunks({
                indexBuildId: resolved.build.indexBuildId,
                path: code.logicalPath,
            });
            await storage.close();
            assert.ok(documentChunks);
            assert.ok(documentChunks.chunks.length > 1);
            assert.ok(documentChunks.chunks.every(({ metadata }) =>
                metadata.chunkingStrategy === "sliding-window"
            ));
            assert.ok(codeChunks);
            assert.ok(codeChunks.chunks.every(({ metadata }) =>
                metadata.chunkingStrategy === "cast"
            ));

            await service.removeSources(collection.collectionId, [code.sourceId]);
            await assert.rejects(
                service.retrieve(collection.collectionId, { query: "anything" }),
                (error: unknown) => error instanceof CollectionError &&
                    error.code === "build-required",
            );
            const secondBuild = await service.buildCollection(collection.collectionId, {
                maximumChunkSize: 120,
                slidingWindowOverlap: 20,
            });
            assert.equal(secondBuild.sourceCount, 1);
            assert.equal(secondBuild.reusedDocuments, 1);
            assert.ok(secondBuild.reusedChunks > 0);
            assert.equal((await service.listCollections())[0]?.needsBuild, false);

            const deleted = await service.deleteCollection(collection.collectionId);
            assert.equal(deleted.collectionId, collection.collectionId);
            assert.equal(deleted.name, "Personal notes");
            await assert.rejects(access(collectionDirectory(
                directory,
                collection.collectionId,
            )));
            assert.deepEqual(await service.listCollections(), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("sets, adds, removes, and clears source tags idempotently", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-tags-"));

        try {
            const service = new CollectionService({
                embeddingProvider: new DeterministicFakeEmbeddingProvider(16),
                collectionsDirectory: directory,
            });
            const collection = await service.createCollection("Tagged sources");
            const added = await service.upsertDocuments(collection.collectionId, [{
                externalId: "note:one",
                content: "A tagged note",
                tags: ["one"],
            }]);
            const sourceId = added.sources[0]!.sourceId;

            const withAddedTags = await service.addSourceTags(
                collection.collectionId,
                [sourceId],
                ["two", "one"],
            );
            assert.deepEqual(withAddedTags.sources[0]!.tags, ["one", "two"]);
            assert.equal(withAddedTags.sourcesRevision, added.sourcesRevision + 1);

            const unchangedAdd = await service.addSourceTags(
                collection.collectionId,
                [sourceId],
                ["one"],
            );
            assert.equal(unchangedAdd.sourcesRevision, withAddedTags.sourcesRevision);

            const withRemovedTag = await service.removeSourceTags(
                collection.collectionId,
                [sourceId],
                ["one"],
            );
            assert.deepEqual(withRemovedTag.sources[0]!.tags, ["two"]);

            const withSetTags = await service.setSourceTags(
                collection.collectionId,
                [sourceId],
                ["final", "archive", "final"],
            );
            assert.deepEqual(withSetTags.sources[0]!.tags, ["archive", "final"]);

            const cleared = await service.clearSourceTags(
                collection.collectionId,
                [sourceId],
            );
            assert.deepEqual(cleared.sources[0]!.tags, []);
            const unchangedClear = await service.clearSourceTags(
                collection.collectionId,
                [sourceId],
            );
            assert.equal(unchangedClear.sourcesRevision, cleared.sourcesRevision);

            await assert.rejects(
                service.addSourceTags(
                    collection.collectionId,
                    [sourceId, "source_missing"],
                    ["never-applied"],
                ),
                (error: unknown) => error instanceof CollectionError &&
                    error.code === "source-not-found",
            );
            assert.deepEqual(
                (await service.listSources(collection.collectionId))[0]!.tags,
                [],
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
