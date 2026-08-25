import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { hashText } from "scribery-core";
import { SqliteStorageProvider } from "scribery-core";
import {
    managedDatabasePath,
    ProjectRetrievalTargetService,
    writeManagedProjectManifest,
} from "../index.js";

describe("project retrieval targets", () => {
    it("selects, updates, and removes named immutable builds", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-targets-"));
        const indexesDirectory = join(directory, "indexes");
        const root = join(directory, "project");
        const databasePath = managedDatabasePath(root, indexesDirectory);
        await mkdir(dirname(databasePath), { recursive: true });
        const manifest = await writeManagedProjectManifest(
            root,
            databasePath,
            indexesDirectory,
        );
        assert.ok(manifest);
        await createReadyBuild(databasePath, "build_release_1", 1);
        await createReadyBuild(databasePath, "build_release_2", 2);

        const service = new ProjectRetrievalTargetService({ indexesDirectory });
        const initial = await service.status(undefined, root);
        assert.deepEqual(initial.active, {
            type: "latest-ready",
            indexBuildId: "build_release_2",
        });

        await service.assignTarget(
            manifest.projectIdentifier,
            "release128",
            "build_release_1",
        );
        await service.switchTarget(undefined, "release128", root);
        assert.deepEqual((await service.status(undefined, root)).active, {
            type: "target",
            target: "release128",
            indexBuildId: "build_release_1",
        });

        await service.assignTarget(
            manifest.projectIdentifier,
            "release128",
            "build_release_2",
        );
        assert.deepEqual((await service.status(undefined, root)).active, {
            type: "target",
            target: "release128",
            indexBuildId: "build_release_2",
        });

        await assert.rejects(
            service.removeTarget(undefined, "release128", root),
            /is active and cannot be removed/u,
        );
        await service.switchBuild(undefined, "build_release_1", root);
        const removed = await service.removeTarget(undefined, "release128", root);
        assert.equal(removed.removed, "release128");
        assert.deepEqual(removed.active, {
            type: "build",
            indexBuildId: "build_release_1",
        });
    });

    it("retains one replaced build and deletes only unreferenced releases", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-retention-"));
        const indexesDirectory = join(directory, "indexes");
        const root = join(directory, "project");
        const databasePath = managedDatabasePath(root, indexesDirectory);
        await mkdir(dirname(databasePath), { recursive: true });
        const manifest = await writeManagedProjectManifest(
            root,
            databasePath,
            indexesDirectory,
        );
        assert.ok(manifest);
        await createReadyBuild(databasePath, "build_1", 1);
        await createReadyBuild(databasePath, "build_2", 2);
        await createReadyBuild(databasePath, "build_3", 3);
        await createReadyBuild(databasePath, "build_4", 4);

        const service = new ProjectRetrievalTargetService({ indexesDirectory });
        await service.assignTarget(
            manifest.projectIdentifier,
            "legacy",
            "build_1",
        );
        await service.assignTarget(
            manifest.projectIdentifier,
            "release",
            "build_1",
            true,
            1,
        );
        const second = await service.assignTarget(
            manifest.projectIdentifier,
            "release",
            "build_2",
            true,
            1,
        );
        assert.deepEqual(
            (second.target as { retainedBuildIds: readonly string[] })
                .retainedBuildIds,
            ["build_1"],
        );
        const renamed = await service.renameTarget(
            undefined,
            "release",
            "stable",
            root,
        );
        assert.deepEqual(renamed.renamed, {
            from: "release",
            to: "stable",
        });
        assert.deepEqual(
            (renamed.target as { retainedBuildIds: readonly string[] })
                .retainedBuildIds,
            ["build_1"],
        );
        assert.deepEqual(renamed.active, {
            type: "target",
            target: "stable",
            indexBuildId: "build_2",
        });
        await assert.rejects(
            service.renameTarget(undefined, "stable", "legacy", root),
            /already exists/u,
        );

        const third = await service.assignTarget(
            manifest.projectIdentifier,
            "stable",
            "build_3",
            true,
            1,
        );
        assert.deepEqual(
            (third.retention as { protectedBuildIds: readonly string[] })
                .protectedBuildIds,
            ["build_1"],
        );
        assert.deepEqual((await service.status(undefined, root)).active, {
            type: "target",
            target: "stable",
            indexBuildId: "build_3",
        });
        assert.deepEqual(
            await buildIds(databasePath),
            ["build_1", "build_2", "build_3", "build_4"],
        );

        const legacy = await service.assignTarget(
            manifest.projectIdentifier,
            "legacy",
            "build_4",
            false,
            0,
        );
        assert.deepEqual(
            (legacy.retention as {
                deletedBuilds: readonly { indexBuildId: string }[];
            }).deletedBuilds.map(({ indexBuildId }) => indexBuildId),
            ["build_1"],
        );

        const release = await service.assignTarget(
            manifest.projectIdentifier,
            "stable",
            "build_4",
            true,
            0,
        );
        assert.deepEqual(
            (release.retention as {
                deletedBuilds: readonly { indexBuildId: string }[];
            }).deletedBuilds.map(({ indexBuildId }) => indexBuildId),
            ["build_3", "build_2"],
        );
        assert.deepEqual(await buildIds(databasePath), ["build_4"]);
    });

    it("protects an exact active-build selection during target cleanup", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-active-build-"));
        const indexesDirectory = join(directory, "indexes");
        const root = join(directory, "project");
        const databasePath = managedDatabasePath(root, indexesDirectory);
        await mkdir(dirname(databasePath), { recursive: true });
        const manifest = await writeManagedProjectManifest(
            root,
            databasePath,
            indexesDirectory,
        );
        assert.ok(manifest);
        await createReadyBuild(databasePath, "build_1", 1);
        await createReadyBuild(databasePath, "build_2", 2);
        await createReadyBuild(databasePath, "build_3", 3);

        const service = new ProjectRetrievalTargetService({ indexesDirectory });
        await service.assignTarget(
            manifest.projectIdentifier,
            "release",
            "build_1",
            true,
            1,
        );
        await service.assignTarget(
            manifest.projectIdentifier,
            "release",
            "build_2",
            true,
            1,
        );
        await service.switchBuild(undefined, "build_1", root);
        const result = await service.assignTarget(
            manifest.projectIdentifier,
            "release",
            "build_3",
            false,
            0,
        );

        assert.deepEqual(
            (result.retention as { protectedBuildIds: readonly string[] })
                .protectedBuildIds,
            ["build_1"],
        );
        assert.deepEqual(await buildIds(databasePath), ["build_1", "build_3"]);
        assert.deepEqual((await service.status(undefined, root)).active, {
            type: "build",
            indexBuildId: "build_1",
        });
    });

    it("deletes only builds that are neither active nor target-referenced", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-delete-build-"));
        const indexesDirectory = join(directory, "indexes");
        const root = join(directory, "project");
        const databasePath = managedDatabasePath(root, indexesDirectory);
        await mkdir(dirname(databasePath), { recursive: true });
        const manifest = await writeManagedProjectManifest(
            root,
            databasePath,
            indexesDirectory,
        );
        assert.ok(manifest);
        await createReadyBuild(databasePath, "build_target", 1);
        await createReadyBuild(databasePath, "build_obsolete", 2);
        await createReadyBuild(databasePath, "build_active", 3);

        const service = new ProjectRetrievalTargetService({ indexesDirectory });
        await service.assignTarget(
            manifest.projectIdentifier,
            "legacy",
            "build_target",
        );

        await assert.rejects(
            service.deleteBuild(undefined, "build_active", root),
            /active or referenced/u,
        );
        await assert.rejects(
            service.deleteBuild(undefined, "build_target", root),
            /active or referenced/u,
        );

        const deleted = await service.deleteBuild(
            undefined,
            "build_obsolete",
            root,
        );
        assert.equal(deleted.indexBuildId, "build_obsolete");
        assert.deepEqual(
            await buildIds(databasePath),
            ["build_active", "build_target"],
        );
    });
});

async function buildIds(databasePath: string): Promise<readonly string[]> {
    const storage = new SqliteStorageProvider(databasePath, {
        readOnly: true,
        immutable: true,
    });

    try {
        return (await storage.listBuilds())
            .map(({ indexBuildId }) => indexBuildId)
            .sort();
    } finally {
        await storage.close();
    }
}

async function createReadyBuild(
    databasePath: string,
    indexBuildId: string,
    timestamp: number,
): Promise<void> {
    const storage = new SqliteStorageProvider(databasePath);

    try {
        await storage.beginBuild({
            indexBuildId,
            repositoryId: "repository_fixture",
            snapshotId: `snapshot_${timestamp}`,
            sourceIdentity: `git:fixture:${timestamp}`,
            configurationHash: hashText("configuration"),
            modelIdentity: {
                provider: "fixture",
                model: "fixture",
                dimensions: 3,
                metric: "cosine",
            },
            status: "building",
            createdAt: new Date(timestamp).toISOString(),
        });
        await storage.setBuildStatus(
            indexBuildId,
            "ready",
            new Date(timestamp).toISOString(),
        );
    } finally {
        await storage.close();
    }
}
