import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DeterministicFakeEmbeddingProvider } from "scribery-core";
import { SqliteStorageProvider } from "scribery-core";
import {
    documentationDirectory,
    DocumentationError,
    DocumentationService,
} from "../index.js";

describe("DocumentationService", () => {
    it("manages, builds, and hard-scopes generic code and text sources", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-documentation-"));

        try {
            const service = new DocumentationService({
                embeddingProvider: new DeterministicFakeEmbeddingProvider(16),
                documentationsDirectory: directory,
            });
            const documentation = await service.createDocumentation("Personal notes");
            await service.upsertDocuments(documentation.documentationId, [
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
                service.retrieve(documentation.documentationId, { query: "session token" }),
                (error: unknown) => {
                    assert.ok(error instanceof DocumentationError);
                    assert.equal(error.code, "build-required");
                    return true;
                },
            );

            const firstBuild = await service.buildDocumentation(documentation.documentationId, {
                maximumChunkSize: 120,
                slidingWindowOverlap: 20,
            });
            assert.equal(firstBuild.sourceCount, 2);
            assert.equal(firstBuild.diagnostics.length, 0);
            assert.ok(firstBuild.indexedChunks > 2);

            const sources = await service.listSources(documentation.documentationId);
            const note = sources.find(({ externalId }) =>
                externalId === "note:authentication"
            );
            const code = sources.find(({ externalId }) => externalId === "code:example");
            assert.ok(note);
            assert.ok(code);

            assert.deepEqual(
                await service.retrieve(documentation.documentationId, {
                    query: "session token",
                    scope: { sourceIds: [] },
                }),
                [],
            );
            const scoped = await service.retrieve(documentation.documentationId, {
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

            const tagged = await service.retrieve(documentation.documentationId, {
                query: "session token",
                scope: { tags: ["selected"] },
                limit: 5,
            });
            assert.ok(tagged.length > 0);
            assert.ok(tagged.every(({ sourceId }) => sourceId === note.sourceId));

            const resolved = await service.resolveActiveBuild(documentation.documentationId);
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

            await service.removeSources(documentation.documentationId, [code.sourceId]);
            await assert.rejects(
                service.retrieve(documentation.documentationId, { query: "anything" }),
                (error: unknown) => error instanceof DocumentationError &&
                    error.code === "build-required",
            );
            const secondBuild = await service.buildDocumentation(documentation.documentationId, {
                maximumChunkSize: 120,
                slidingWindowOverlap: 20,
            });
            assert.equal(secondBuild.sourceCount, 1);
            assert.equal(secondBuild.reusedDocuments, 1);
            assert.ok(secondBuild.reusedChunks > 0);
            assert.equal((await service.listDocumentations())[0]?.needsBuild, false);

            const deleted = await service.deleteDocumentation(documentation.documentationId);
            assert.equal(deleted.documentationId, documentation.documentationId);
            assert.equal(deleted.name, "Personal notes");
            await assert.rejects(access(documentationDirectory(
                directory,
                documentation.documentationId,
            )));
            assert.deepEqual(await service.listDocumentations(), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("sets, adds, removes, and clears source tags idempotently", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-tags-"));

        try {
            const service = new DocumentationService({
                embeddingProvider: new DeterministicFakeEmbeddingProvider(16),
                documentationsDirectory: directory,
            });
            const documentation = await service.createDocumentation("Tagged sources");
            const added = await service.upsertDocuments(documentation.documentationId, [{
                externalId: "note:one",
                content: "A tagged note",
                tags: ["one"],
            }]);
            const sourceId = added.sources[0]!.sourceId;

            const withAddedTags = await service.addSourceTags(
                documentation.documentationId,
                [sourceId],
                ["two", "one"],
            );
            assert.deepEqual(withAddedTags.sources[0]!.tags, ["one", "two"]);
            assert.equal(withAddedTags.sourcesRevision, added.sourcesRevision + 1);

            const unchangedAdd = await service.addSourceTags(
                documentation.documentationId,
                [sourceId],
                ["one"],
            );
            assert.equal(unchangedAdd.sourcesRevision, withAddedTags.sourcesRevision);

            const withRemovedTag = await service.removeSourceTags(
                documentation.documentationId,
                [sourceId],
                ["one"],
            );
            assert.deepEqual(withRemovedTag.sources[0]!.tags, ["two"]);

            const withSetTags = await service.setSourceTags(
                documentation.documentationId,
                [sourceId],
                ["final", "archive", "final"],
            );
            assert.deepEqual(withSetTags.sources[0]!.tags, ["archive", "final"]);

            const cleared = await service.clearSourceTags(
                documentation.documentationId,
                [sourceId],
            );
            assert.deepEqual(cleared.sources[0]!.tags, []);
            const unchangedClear = await service.clearSourceTags(
                documentation.documentationId,
                [sourceId],
            );
            assert.equal(unchangedClear.sourcesRevision, cleared.sourcesRevision);

            await assert.rejects(
                service.addSourceTags(
                    documentation.documentationId,
                    [sourceId, "source_missing"],
                    ["never-applied"],
                ),
                (error: unknown) => error instanceof DocumentationError &&
                    error.code === "source-not-found",
            );
            assert.deepEqual(
                (await service.listSources(documentation.documentationId))[0]!.tags,
                [],
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
