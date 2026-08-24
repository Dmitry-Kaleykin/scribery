import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import type { IndexingResult } from "scribery-core";
import {
    deleteIndexedProject,
    listIndexedProjects,
    managedDatabasePath,
    managedProjectIdentifier,
    writeManagedProjectManifest,
} from "scribery-code";
import { SqliteStorageProvider } from "scribery-core";
import { writeIndexingLog } from "../logging/indexing-log.js";

describe("CLI project management", () => {
    it("lists and deletes a managed project by its stable identifier", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-cli-"));
        const indexesDirectory = join(directory, "indexes");
        const root = join(directory, "source");
        const projectIdentifier = managedProjectIdentifier(root);
        const databasePath = managedDatabasePath(root, indexesDirectory);
        await mkdir(dirname(databasePath), { recursive: true });
        await writeManagedProjectManifest(root, databasePath, indexesDirectory);

        const storage = new SqliteStorageProvider(databasePath);
        await storage.beginBuild({
            indexBuildId: "index-build_ready",
            repositoryId: "repository_ready",
            snapshotId: "snapshot_ready",
            sourceIdentity: "directory:fixture",
            configurationHash: "configuration",
            modelIdentity: {
                provider: "fixture",
                model: "embedding-fixture",
                dimensions: 3,
                metric: "cosine",
            },
            status: "building",
            createdAt: new Date(0).toISOString(),
        });
        await storage.setBuildStatus(
            "index-build_ready",
            "ready",
            new Date(1).toISOString(),
        );
        await storage.close();

        const projects = await listIndexedProjects(indexesDirectory);
        assert.equal(projects.length, 1);
        assert.equal(projects[0]?.projectIdentifier, projectIdentifier);
        assert.equal(projects[0]?.root, root);
        assert.equal(
            projects[0]?.latestReadyBuild?.indexBuildId,
            "index-build_ready",
        );
        assert.equal(projects[0]?.buildsByStatus.ready, 1);

        const deleted = await deleteIndexedProject(
            projectIdentifier,
            indexesDirectory,
        );
        assert.equal(deleted.projectIdentifier, projectIdentifier);
        await assert.rejects(access(dirname(databasePath)));
    });

    it("moves detailed indexing diagnostics into a build log", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-log-"));
        const databasePath = join(directory, "index.sqlite");
        const result: IndexingResult = {
            repositoryId: "repository_fixture",
            snapshotId: "snapshot_fixture",
            indexBuildId: "index-build_fixture",
            discoveredFiles: 2,
            indexedDocuments: 1,
            indexedChunks: 3,
            reusedDocuments: 0,
            reusedChunks: 0,
            reusedEmbeddings: 0,
            generatedEmbeddings: 3,
            reused: false,
            diagnostics: [{
                stage: "policy",
                path: "README.md",
                code: "plain-text",
                message: "File was not indexed: plain-text",
            }],
        };

        const summary = await writeIndexingLog(directory, databasePath, result);
        const log = JSON.parse(await readFile(summary.logPath, "utf8")) as {
            diagnostics: unknown[];
        };

        assert.equal(summary.diagnosticCount, 1);
        assert.equal(summary.indexBuildId, result.indexBuildId);
        assert.equal(summary.reusedEmbeddings, 0);
        assert.equal(summary.generatedEmbeddings, 3);
        assert.equal(log.diagnostics.length, 1);
        assert.equal("diagnostics" in summary, false);
    });
});
