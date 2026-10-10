import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";

import { hashText, SqliteStorageProvider } from "scribery-core";
import {
    managedDatabasePath, ProjectLiveIndexingService, ProjectLiveIndexingStateCatalog,
    ProjectRetrievalTargetCatalog, ProjectRetrievalTargetService, writeManagedProjectManifest,
    type ProjectIndexingOutcome,
} from "../index.js";
import { ProjectLiveBuildCache } from "../live/live-build-cache.js";
import type { SourceState } from "../../source-control/index.js";

it("keeps live targets separate, restores the previous target, and preserves branch builds", async () => {
    const fixture = await createFixture();
    let branch = "feature/a";
    let change: ((path?: string) => void) | undefined;
    let build = 0;
    const service = new ProjectLiveIndexingService({
        indexesDirectory: fixture.indexesDirectory,
        inspectSource: async () => sourceState(fixture.root, branch),
        index: async () => {
            const id = `live_${++build}`;
            await readyBuild(fixture.databasePath, id, build + 10);
            return { result: { indexBuildId: id, reused: false } } as ProjectIndexingOutcome;
        },
        watchRoot: (_root, onChange) => { change = onChange; return { close() {} }; },
    });
    try {
        await fixture.targets.assignTarget(fixture.projectIdentifier, "release25", "original", true);
        await service.start({ root: fixture.root, provider: provider(), debounceMilliseconds: 5, minimumBuildIntervalMilliseconds: 5 });
        const listing = await fixture.targets.list(undefined, fixture.root);
        assert.equal(listing.targetCount, 1);
        assert.equal((listing.live as { name: string }).name, "live/current");
        assert.deepEqual((listing.targets as Array<{ name: string }>).map(({ name }) => name), ["release25"]);
        branch = "feature/b";
        change?.("source.ts");
        await waitFor(() => service.status?.phase === "ready" && service.status.branch === branch);
        assert.equal((await fixture.targets.list(undefined, fixture.root)).targetCount, 1);
        await service.stop();
        const stopped = await fixture.targets.list(undefined, fixture.root);
        assert.equal(stopped.live, null);
        assert.deepEqual(stopped.active, { type: "target", target: "release25", indexBuildId: "original" });
        assert.deepEqual(await buildIds(fixture.databasePath), ["live_1", "live_2", "original"]);
    } finally {
        await service.stop();
        await fixture.remove();
    }
});

for (const selection of ["fallback", "build", "none"] as const) {
    it(`restores a previous ${selection} selection after shutdown`, async () => {
        const fixture = await createFixture();
        const service = new ProjectLiveIndexingService({
            indexesDirectory: fixture.indexesDirectory,
            inspectSource: async () => sourceState(fixture.root, "feature"),
            index: async () => {
                await readyBuild(fixture.databasePath, "live", 2);
                return { result: { indexBuildId: "live", reused: false } } as ProjectIndexingOutcome;
            },
            watchRoot: () => ({ close() {} }),
        });
        try {
            if (selection === "build") await fixture.targets.switchBuild(undefined, "original", fixture.root);
            if (selection === "none") await fixture.targets.deactivate(undefined, fixture.root);
            await service.start({ root: fixture.root, provider: provider() });
            if (selection === "build") {
                await assert.rejects(fixture.targets.deleteBuild(undefined, "original", fixture.root), /cannot be deleted/u);
            }
            await service.stop();
            assert.deepEqual((await fixture.targets.status(undefined, fixture.root)).active,
                selection === "none" ? null : { type: "build", indexBuildId: "original" });
        } finally {
            await service.stop();
            await fixture.remove();
        }
    });
}

it("recovers expired sessions during retrieval without overwriting a newer selection", async () => {
    const fixture = await createFixture();
    const catalog = new ProjectRetrievalTargetCatalog(fixture.indexesDirectory);
    const states = new ProjectLiveIndexingStateCatalog(fixture.indexesDirectory);
    try {
        await readyBuild(fixture.databasePath, "live", 2);
        await fixture.targets.assignTarget(fixture.projectIdentifier, "stable", "original", true);
        await fixture.targets.assignLiveTarget(fixture.projectIdentifier, "live", "expired-session");
        const old = new Date(Date.now() - 20_000).toISOString();
        await states.write({
            schemaVersion: 1, sessionId: "expired-session", processId: process.pid,
            projectIdentifier: fixture.projectIdentifier, root: fixture.root,
            phase: "indexing", generation: 3, startedAt: old, updatedAt: old,
            target: "live/current", previousSelection: { type: "target", target: "stable" },
        });
        assert.deepEqual((await fixture.targets.status(undefined, fixture.root)).active,
            { type: "target", target: "stable", indexBuildId: "original" });
        assert.equal((await fixture.targets.list(undefined, fixture.root)).live, null);

        await fixture.targets.assignLiveTarget(fixture.projectIdentifier, "live", "expired-session");
        await fixture.targets.switchBuild(undefined, "live", fixture.root);
        await fixture.targets.status(undefined, fixture.root);
        assert.deepEqual((await catalog.read(fixture.projectIdentifier)).active, { type: "build", indexBuildId: "live" });

        await fixture.targets.assignLiveTarget(fixture.projectIdentifier, "live", "new-session");
        await catalog.releaseLiveTarget(fixture.projectIdentifier, "expired-session", { type: "target", target: "stable" });
        assert.equal((await catalog.read(fixture.projectIdentifier)).targets.find(({ name }) => name === "live/current")?.liveSessionId, "new-session");
    } finally {
        await fixture.remove();
    }
});

it("bounds only tracked live builds and protects selections and permanent history", async () => {
    const fixture = await createFixture();
    const cache = new ProjectLiveBuildCache(fixture.indexesDirectory);
    const states = new ProjectLiveIndexingStateCatalog(fixture.indexesDirectory);
    try {
        for (let i = 0; i < 7; i++) {
            await readyBuild(fixture.databasePath, `build_${i}`, i + 2);
            await cache.record(fixture.projectIdentifier, `build_${i}`, false);
        }
        await readyBuild(fixture.databasePath, "manual-unreferenced", 20);
        await cache.record(fixture.projectIdentifier, "manual-unreferenced", true);
        await fixture.targets.assignTarget(fixture.projectIdentifier, "release25", "build_1", true);
        await fixture.targets.assignTarget(fixture.projectIdentifier, "release25", "build_0", true, 1);
        await fixture.targets.assignLiveTarget(fixture.projectIdentifier, "build_3", "session");
        const now = new Date().toISOString();
        await states.write({
            schemaVersion: 1, sessionId: "session", processId: process.pid,
            projectIdentifier: fixture.projectIdentifier, root: fixture.root,
            phase: "indexing", generation: 1, startedAt: now, updatedAt: now,
            previousSelection: { type: "build", indexBuildId: "build_2" },
        });
        const project = await fixture.targets.resolveProject(undefined, fixture.root);
        await cache.prune(project, 1);
        assert.deepEqual(await buildIds(fixture.databasePath), ["build_0", "build_1", "build_2", "build_3", "build_6", "manual-unreferenced", "original"]);
        await cache.prune(project, 0);
        assert.ok(!(await buildIds(fixture.databasePath)).includes("build_6"));
    } finally {
        await fixture.remove();
    }
});

it("explicitly migrates legacy targets while retaining their immutable builds", async () => {
    const fixture = await createFixture();
    try {
        await fixture.targets.assignTarget(fixture.projectIdentifier, "release25", "original");
        await readyBuild(fixture.databasePath, "feature-build", 2);
        await fixture.targets.assignTarget(fixture.projectIdentifier, "live/feature", "feature-build", true);
        const result = await fixture.targets.cleanupLegacyLiveTargets(undefined, fixture.root);
        assert.deepEqual(result.removed, ["live/feature"]);
        const listing = await fixture.targets.list(undefined, fixture.root);
        assert.deepEqual((listing.targets as Array<{ name: string }>).map(({ name }) => name), ["release25"]);
        assert.deepEqual(listing.active, { type: "build", indexBuildId: "feature-build" });
        assert.deepEqual(await buildIds(fixture.databasePath), ["feature-build", "original"]);
        const entries = JSON.parse(await readFile(join(fixture.indexesDirectory, fixture.projectIdentifier, "live-build-cache.json"), "utf8")) as Array<{ indexBuildId: string }>;
        assert.equal(entries[0]?.indexBuildId, "feature-build");
    } finally {
        await fixture.remove();
    }
});

it("indexes prepared snapshots and reuses artifacts after removing the temporary target", async () => {
    const fixture = await createFixture();
    let branch = "feature/a";
    let inputs = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        inputs += body.input.length;
        return new Response(JSON.stringify({ data: body.input.map((_input, index) => ({ index, embedding: [1, 2, 3] })) }), {
            status: 200, headers: { "Content-Type": "application/json" },
        });
    };
    const service = new ProjectLiveIndexingService({
        indexesDirectory: fixture.indexesDirectory, fetch, apiKey: "fixture",
        inspectSource: async () => sourceState(fixture.root, branch),
        watchRoot: () => ({ close() {} }),
    });
    try {
        await writeFile(join(fixture.root, "first.ts"), "export const first = 42;\n");
        const first = await service.start({ root: fixture.root, provider: provider() });
        assert.equal(first.phase, "ready", first.error?.message ?? "First build failed");
        await service.stop();
        const before = inputs;
        branch = "feature/b";
        await writeFile(join(fixture.root, "second.ts"), "export const second = 99;\n");
        const events: Array<{ reusedDocuments?: number }> = [];
        const second = await service.start({ root: fixture.root, provider: provider(), onEvent: (event) => {
            if (event.type === "indexing" && event.event.type === "indexing-progress") events.push(event.event.progress);
        } });
        assert.equal(second.phase, "ready", second.error?.message ?? "Second build failed");
        assert.ok(events.some(({ reusedDocuments }) => (reusedDocuments ?? 0) > 0));
        assert.ok(inputs > before);
        await service.stop();
        assert.equal((await fixture.targets.list(undefined, fixture.root)).live, null);
    } finally {
        await service.stop();
        await fixture.remove();
    }
});

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), "scribery-live-lifecycle-"));
    const root = join(directory, "project");
    const indexesDirectory = join(directory, "indexes");
    const databasePath = managedDatabasePath(root, indexesDirectory);
    await mkdir(root, { recursive: true });
    await mkdir(dirname(databasePath), { recursive: true });
    const project = await writeManagedProjectManifest(root, databasePath, indexesDirectory);
    assert.ok(project);
    await readyBuild(databasePath, "original", 1);
    return {
        root, indexesDirectory, databasePath, projectIdentifier: project.projectIdentifier,
        targets: new ProjectRetrievalTargetService({ indexesDirectory }),
        remove: () => rm(directory, { recursive: true, force: true }),
    };
}

async function readyBuild(databasePath: string, indexBuildId: string, timestamp: number): Promise<void> {
    const storage = new SqliteStorageProvider(databasePath);
    try {
        await storage.beginBuild({
            indexBuildId, repositoryId: "repository_fixture", snapshotId: `snapshot_${timestamp}`,
            sourceIdentity: `git:fixture:${timestamp}`, configurationHash: hashText("configuration"),
            modelIdentity: { provider: "fixture", model: "fixture", dimensions: 3, metric: "cosine" },
            status: "building", createdAt: new Date(timestamp).toISOString(),
        });
        await storage.setBuildStatus(indexBuildId, "ready", new Date(timestamp).toISOString());
    } finally {
        await storage.close();
    }
}

async function buildIds(databasePath: string): Promise<string[]> {
    const storage = new SqliteStorageProvider(databasePath);
    try { return (await storage.listBuilds()).map(({ indexBuildId }) => indexBuildId).sort(); }
    finally { await storage.close(); }
}

function sourceState(root: string, refName: string): SourceState {
    return {
        kind: "git",
        context: { provider: "git", repositoryId: "repository_fixture", repositoryRoot: root, indexingRoot: root, indexingRootRelativePath: ".", worktreeRoot: root },
        state: { repositoryId: "repository_fixture", headCommit: "a".repeat(40), refName, detached: false, unborn: false, dirty: false, changes: [] },
    };
}

function provider() {
    return { type: "inline" as const, embedding: { provider: "openai-compatible" as const, model: "fixture", dimensions: 3, baseUrl: "http://fixture.invalid/v1" } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for live state");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
