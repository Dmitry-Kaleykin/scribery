import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
    ProjectIndexingOutcome,
    ProjectIndexingRequest,
    ProjectLiveIndexingEvent,
} from "../index.js";
import {
    liveTargetName,
    ProjectLiveIndexingService,
    ProjectLiveIndexingStateCatalog,
} from "../index.js";
import type {
    SourceState,
    WorkingTreeState,
} from "../../source-control/index.js";

const PROJECT_IDENTIFIER = "0123456789abcdef01234567";

describe("branch-aware live indexing", () => {
    it("publishes and advances an automatic target for the current branch", async () => {
        const fixture = await createFixture();
        try {
            let state = gitState("release7", "a".repeat(40));
            let onChange: ((path?: string) => void) | undefined;
            const assignments: Array<{
                target: string;
                indexBuildId: string;
            }> = [];
            const events: ProjectLiveIndexingEvent[] = [];
            const requests: ProjectIndexingRequest[] = [];
            let build = 0;
            const service = new ProjectLiveIndexingService({
                indexesDirectory: fixture.indexesDirectory,
                inspectSource: async () => sourceState(fixture.root, state),
                resolveProject: async () => projectSummary(fixture.root),
                index: async (request) => {
                    requests.push(request);
                    return outcome(`index-build_${++build}`);
                },
                assignTarget: async (_project, target, indexBuildId) => {
                    assignments.push({ target, indexBuildId });
                    return {};
                },
                watchRoot: (_root, change) => {
                    onChange = change;
                    return { close() {} };
                },
            });

            const initial = await service.start({
                root: fixture.root,
                provider: inlineProvider(),
                debounceMilliseconds: 5,
                pollIntervalMilliseconds: 1_000,
                onEvent: (event) => events.push(event),
            });
            assert.equal(initial.phase, "ready");
            assert.equal(initial.branch, "release7");
            assert.equal(initial.target, "live/release7");
            assert.deepEqual(assignments, [{
                target: "live/release7",
                indexBuildId: "index-build_1",
            }]);
            assert.equal(requests[0]?.target, undefined);
            assert.equal(requests[0]?.allowDirty, true);
            assert.equal(requests[0]?.diagnoseProvider, true);
            assert.equal(requests[0]?.persistRecipe, false);

            state = gitState("task123", "b".repeat(40));
            onChange?.("src/feature.ts");
            assert.equal(service.status?.phase, "pending");
            await waitFor(() => service.status?.phase === "ready" &&
                service.status.target === "live/task123");
            assert.deepEqual(assignments.at(-1), {
                target: "live/task123",
                indexBuildId: "index-build_2",
            });
            assert.equal(requests[1]?.diagnoseProvider, false);
            assert.ok(events.some((event) =>
                event.type === "status" && event.status.phase === "pending"
            ));
            await service.stop();
            assert.equal(service.status?.phase, "stopped");
        } finally {
            await fixture.remove();
        }
    });

    it("does not publish an obsolete branch when it changes during a build", async () => {
        const fixture = await createFixture();
        try {
            let state = gitState("release7", "a".repeat(40));
            let onChange: ((path?: string) => void) | undefined;
            const builds: Array<Deferred<ProjectIndexingOutcome>> = [];
            const assignments: string[] = [];
            const service = new ProjectLiveIndexingService({
                indexesDirectory: fixture.indexesDirectory,
                inspectSource: async () => sourceState(fixture.root, state),
                resolveProject: async () => projectSummary(fixture.root),
                index: async () => {
                    const pending = deferred<ProjectIndexingOutcome>();
                    builds.push(pending);
                    return pending.promise;
                },
                assignTarget: async (_project, target) => {
                    assignments.push(target);
                    return {};
                },
                watchRoot: (_root, change) => {
                    onChange = change;
                    return { close() {} };
                },
            });

            const starting = service.start({
                root: fixture.root,
                provider: inlineProvider(),
                debounceMilliseconds: 5,
                pollIntervalMilliseconds: 1_000,
            });
            await waitFor(() => builds.length === 1);
            assert.deepEqual(assignments, []);

            state = gitState("task123", "b".repeat(40));
            onChange?.("src/feature.ts");
            builds[0]!.resolve(outcome("index-build_release"));
            await waitFor(() => builds.length === 2);
            assert.deepEqual(assignments, []);
            builds[1]!.resolve(outcome("index-build_task"));
            const ready = await starting;

            assert.equal(ready.target, "live/task123");
            assert.deepEqual(assignments, ["live/task123"]);
            await service.stop();
        } finally {
            await fixture.remove();
        }
    });

    it("stays available for a manual retry after publication fails", async () => {
        const fixture = await createFixture();
        try {
            const state = gitState("task123", "a".repeat(40));
            let attempts = 0;
            const service = new ProjectLiveIndexingService({
                indexesDirectory: fixture.indexesDirectory,
                inspectSource: async () => sourceState(fixture.root, state),
                resolveProject: async () => projectSummary(fixture.root),
                index: async () => outcome(`index-build_${attempts + 1}`),
                assignTarget: async () => {
                    attempts += 1;
                    if (attempts === 1) throw new Error("catalog unavailable");
                    return {};
                },
                watchRoot: () => ({ close() {} }),
            });

            const failed = await service.start({
                root: fixture.root,
                provider: inlineProvider(),
                pollIntervalMilliseconds: 1_000,
            });
            assert.equal(failed.phase, "failed");
            assert.equal(service.running, true);

            const retried = await service.reconcile();
            assert.equal(retried.phase, "ready");
            assert.equal(retried.target, "live/task123");
            await service.stop();
        } finally {
            await fixture.remove();
        }
    });

    it("pauses implicit retrieval while a fresh live session is stale", async () => {
        const fixture = await createFixture();
        try {
            const catalog = new ProjectLiveIndexingStateCatalog(
                fixture.indexesDirectory,
            );
            const now = new Date().toISOString();
            await catalog.write({
                schemaVersion: 1,
                sessionId: "fixture-session",
                processId: process.pid,
                projectIdentifier: PROJECT_IDENTIFIER,
                root: fixture.root,
                phase: "pending",
                generation: 2,
                startedAt: now,
                updatedAt: now,
                branch: "task123",
                target: "live/task123",
            });
            await assert.rejects(
                catalog.assertReady(PROJECT_IDENTIFIER, "index-build_old"),
                /retrieval is paused/u,
            );

            await catalog.write({
                schemaVersion: 1,
                sessionId: "fixture-session",
                processId: process.pid,
                projectIdentifier: PROJECT_IDENTIFIER,
                root: fixture.root,
                phase: "ready",
                generation: 2,
                startedAt: now,
                updatedAt: new Date().toISOString(),
                branch: "task123",
                target: "live/task123",
                indexBuildId: "index-build_current",
            });
            await catalog.assertReady(
                PROJECT_IDENTIFIER,
                "index-build_current",
            );
            await assert.rejects(
                catalog.assertReady(PROJECT_IDENTIFIER, "index-build_old"),
                /not the active retrieval build/u,
            );
        } finally {
            await fixture.remove();
        }
    });

    it("keeps ordinary branch names readable and encodes unsupported names", () => {
        assert.equal(liveTargetName("release7"), "live/release7");
        assert.equal(liveTargetName("feature/task-123"), "live/feature/task-123");
        assert.match(liveTargetName("feature@{test}"), /^live\/feature-test-[a-f0-9]{10}$/u);
    });
});

async function createFixture(): Promise<{
    root: string;
    indexesDirectory: string;
    remove(): Promise<void>;
}> {
    const directory = await mkdtemp(join(tmpdir(), "scribery-live-test-"));
    const root = join(directory, "project");
    const indexesDirectory = join(directory, "indexes");
    await mkdir(root, { recursive: true });
    return {
        root,
        indexesDirectory,
        remove: () => rm(directory, { recursive: true, force: true }),
    };
}

function projectSummary(root: string) {
    return {
        projectIdentifier: PROJECT_IDENTIFIER,
        root,
        databasePath: join(root, "index.sqlite"),
        databaseBytes: 0,
        buildCount: 1,
        buildsByStatus: {
            building: 0,
            ready: 1,
            failed: 0,
            cancelled: 0,
        },
    };
}

function gitState(refName: string, headCommit: string): WorkingTreeState {
    return {
        repositoryId: "repository-fixture",
        headCommit,
        refName,
        detached: false,
        unborn: false,
        dirty: false,
        changes: [],
    };
}

function sourceState(root: string, state: WorkingTreeState): SourceState {
    return {
        kind: "git",
        context: {
            provider: "git",
            repositoryId: state.repositoryId,
            repositoryRoot: root,
            indexingRoot: root,
            indexingRootRelativePath: ".",
            worktreeRoot: root,
        },
        state,
    };
}

function inlineProvider() {
    return {
        type: "inline" as const,
        embedding: {
            provider: "openai-compatible" as const,
            model: "fixture",
            dimensions: 3,
        },
    };
}

function outcome(indexBuildId: string): ProjectIndexingOutcome {
    return {
        result: { indexBuildId },
    } as unknown as ProjectIndexingOutcome;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
    return {
        promise,
        resolve: (value) => resolvePromise!(value),
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for live state");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
