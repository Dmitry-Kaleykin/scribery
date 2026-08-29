import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DeterministicFakeEmbeddingProvider, SqliteStorageProvider } from "scribery-core";
import {
    documentationDirectory,
    DocumentationError,
    DocumentationService,
} from "../index.js";

describe("DocumentationService", () => {
    it("manages, indexes, and hard-scopes copied code and text sources", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-documentation-"));
        try {
            const service = createService(directory);
            const documentation = await service.createDocumentation("Personal notes");
            const configured = await service.upsertDocuments(documentation.documentationId, [
                {
                    externalId: "note:authentication",
                    logicalPath: "notes/authentication.txt",
                    title: "Authentication notes",
                    content: "Authentication uses a local signed session token. ".repeat(8),
                    tags: ["selected"],
                    attributes: { conversationId: "chat-123", role: "assistant", ordinal: 17 },
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
                isDocumentationError("index-required"),
            );
            const firstIndex = await service.indexDocumentation(documentation.documentationId, {
                maximumChunkSize: 120,
                slidingWindowOverlap: 20,
            });
            assert.equal(firstIndex.sourceCount, 2);
            assert.equal(firstIndex.diagnostics.length, 0);
            assert.ok(firstIndex.indexedChunks > 2);

            const sources = await service.listIndexedSources(documentation.documentationId);
            const note = sources.find(({ logicalPath }) => logicalPath === "notes/authentication.txt");
            const code = sources.find(({ logicalPath }) => logicalPath === "examples/example.js");
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
            assert.ok(documentChunks?.chunks.every(({ metadata }) =>
                metadata.chunkingStrategy === "sliding-window"
            ));
            assert.ok(codeChunks?.chunks.every(({ metadata }) =>
                metadata.chunkingStrategy === "cast"
            ));

            const codeDefinition = configured.sourceDefinitions.find((source) =>
                source.kind === "managed" && source.externalId === "code:example"
            )!;
            await service.removeSourceDefinitions(documentation.documentationId, [codeDefinition.sourceId]);
            await assert.rejects(
                service.retrieve(documentation.documentationId, { query: "anything" }),
                isDocumentationError("index-required"),
            );
            const secondIndex = await service.indexDocumentation(documentation.documentationId, {
                maximumChunkSize: 120,
                slidingWindowOverlap: 20,
            });
            assert.equal(secondIndex.sourceCount, 1);
            assert.equal(secondIndex.reusedDocuments, 1);
            assert.equal((await service.listDocumentations())[0]?.needsIndex, false);

            const deleted = await service.deleteDocumentation(documentation.documentationId);
            assert.equal(deleted.documentationId, documentation.documentationId);
            await assert.rejects(access(documentationDirectory(directory, documentation.documentationId)));
            assert.deepEqual(await service.listDocumentations(), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("discovers directory additions, changes, and deletions through the same index operation", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-directory-documentation-"));
        try {
            const sourceRoot = join(directory, "pi-skills");
            await mkdir(join(sourceRoot, "references"), { recursive: true });
            await writeFile(join(sourceRoot, "SKILL.md"), "# Skill\nOriginal instructions\n", "utf8");
            await writeFile(join(sourceRoot, "stable.md"), "Stable reference\n", "utf8");
            await writeFile(join(sourceRoot, "references", "details.md"), "Old details\n", "utf8");

            const service = createService(join(directory, "catalog"));
            const documentation = await service.createDocumentation("Pi skills");
            const configured = await service.addDirectorySource(documentation.documentationId, {
                root: sourceRoot,
                mountPath: "skills",
                include: ["**/*.md", "*.md"],
                tags: ["pi-skill"],
            });
            assert.equal(configured.sourceDefinitions[0]?.kind, "directory");

            const first = await service.indexDocumentation(documentation.documentationId);
            assert.equal(first.sourceCount, 3);
            assert.equal(first.reusedDocuments, 0);
            assert.deepEqual(
                (await service.listIndexedSources(documentation.documentationId))
                    .map(({ logicalPath }) => logicalPath),
                ["skills/references/details.md", "skills/SKILL.md", "skills/stable.md"],
            );

            const unchanged = await service.indexDocumentation(documentation.documentationId);
            assert.equal(unchanged.reusedBuild, true);
            assert.equal(unchanged.generatedEmbeddings, 0);

            await writeFile(join(sourceRoot, "SKILL.md"), "# Skill\nUpdated instructions\n", "utf8");
            await unlink(join(sourceRoot, "references", "details.md"));
            await writeFile(join(sourceRoot, "references", "new.md"), "New details\n", "utf8");
            const updated = await service.indexDocumentation(documentation.documentationId);
            assert.equal(updated.sourceCount, 3);
            assert.equal(updated.reusedDocuments, 1);
            assert.ok(updated.generatedEmbeddings > 0);
            const indexed = await service.listIndexedSources(documentation.documentationId);
            assert.deepEqual(indexed.map(({ logicalPath }) => logicalPath), [
                "skills/references/new.md",
                "skills/SKILL.md",
                "skills/stable.md",
            ]);
            assert.ok(indexed.every(({ tags }) => tags.includes("pi-skill")));
            assert.equal(new Set(indexed.map(({ sourceId }) => sourceId)).size, 3);
            assert.ok(indexed.every(({ sourceDefinitionId }) =>
                sourceDefinitionId === configured.sourceDefinitions[0]?.sourceId
            ));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("updates source-definition tags idempotently", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-tags-"));
        try {
            const service = createService(directory);
            const documentation = await service.createDocumentation("Tagged sources");
            const added = await service.upsertDocuments(documentation.documentationId, [{
                externalId: "note:one",
                content: "A tagged note",
                tags: ["one"],
            }]);
            const sourceId = added.sourceDefinitions[0]!.sourceId;
            const withAddedTags = await service.addSourceTags(
                documentation.documentationId,
                [sourceId],
                ["two", "one"],
            );
            assert.deepEqual(withAddedTags.sourceDefinitions[0]!.tags, ["one", "two"]);
            assert.equal(
                withAddedTags.configurationRevision,
                added.configurationRevision + 1,
            );
            const unchangedAdd = await service.addSourceTags(
                documentation.documentationId,
                [sourceId],
                ["one"],
            );
            assert.equal(unchangedAdd.configurationRevision, withAddedTags.configurationRevision);
            const cleared = await service.clearSourceTags(documentation.documentationId, [sourceId]);
            assert.deepEqual(cleared.sourceDefinitions[0]!.tags, []);
            const unchangedClear = await service.clearSourceTags(documentation.documentationId, [sourceId]);
            assert.equal(unchangedClear.configurationRevision, cleared.configurationRevision);
            await assert.rejects(
                service.addSourceTags(
                    documentation.documentationId,
                    [sourceId, "source_missing"],
                    ["never-applied"],
                ),
                isDocumentationError("source-not-found"),
            );
            assert.deepEqual(
                (await service.listSourceDefinitions(documentation.documentationId))[0]!.tags,
                [],
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

function createService(documentationsDirectory: string): DocumentationService {
    return new DocumentationService({
        embeddingProvider: new DeterministicFakeEmbeddingProvider(16),
        documentationsDirectory,
    });
}

function isDocumentationError(code: string): (error: unknown) => boolean {
    return (error: unknown) => error instanceof DocumentationError && error.code === code;
}
