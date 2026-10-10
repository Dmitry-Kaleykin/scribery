import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CombinedAutocompleteProvider, type SelectItem } from "@earendil-works/pi-tui";
import { IndexingPresetService, normalizeRetrievalTargetName, ProviderProfileService, type ProjectIndexingRequest } from "scribery";

import type { ProjectPreferenceInput } from "../domain/project-preferences.js";

import {
    currentGitIndexTarget,
    detectProjectRoot,
    localBranchIndexTargets,
    normalizeManualIndexTarget,
} from "../services/index-targets.js";
import { ProjectIndexingController, type ProjectIndexingControllerOptions } from "./project-indexing-controller.js";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec("git", [
        "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
        "-c", "user.name=Scribery Test", "-c", "user.email=test@example.invalid", ...args,
    ], { cwd: root, encoding: "utf8" });
    return stdout.trim();
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "scribery-index-targets-"));
    const root = join(directory, "project");
    await mkdir(root);
    const profilesPath = join(directory, "profiles.json");
    const profiles = new ProviderProfileService({ profilesPath });
    await profiles.set({ name: "local", embedding: {
        provider: "openai-compatible", model: "embedding", dimensions: 4,
    } });
    const presets = new IndexingPresetService({ profilesPath, presetsPath: join(directory, "presets.json") });
    await presets.set({ name: "code", providerProfile: "local" });
    let savedTarget: string | undefined = "release";
    let selections = ["cancel"];
    const menus: Array<{ title: string; items: readonly SelectItem[] }> = [];
    const requests: ProjectIndexingRequest[] = [];
    const saved: ProjectPreferenceInput[] = [];
    const finished = Promise.withResolvers<void>();
    const controller = new ProjectIndexingController({
        cwd: directory,
        profiles, presets,
        operations: {
            begin: () => ({ controller: new AbortController(), startedAt: Date.now() }),
            finish() {},
        },
        providerAccess: { indexingService: async () => ({
            async index(request: ProjectIndexingRequest) {
                requests.push(request);
                return { result: {
                    discoveredFiles: 1, indexedChunks: 1, reusedEmbeddings: 0,
                    indexBuildId: "sha256:test-build",
                } };
            },
        }) },
        preferences: { async set(preference: ProjectPreferenceInput) { saved.push(preference); } },
        refreshProjects: async () => { finished.resolve(); },
        profileController: { pickProfile: async () => "local" },
        pickPreset: async () => "code",
        activeProject: () => ({ projectIdentifier: "project", root }),
        activePreference: () => savedTarget === undefined ? undefined : ({
            profile: "local", preset: "code", target: savedTarget,
        }),
        liveRunning: () => false,
        targets: { list: async () => ({ targets: [
            { name: "release" }, { name: "feature/payments" }, { name: "live/current" },
        ] }) },
        ui: {
            append() {}, appendError(error: unknown) { throw error; }, requestRender() {},
            async pick(title: string, items: readonly SelectItem[]) {
                menus.push({ title, items });
                assert.ok(selections.length, `Unexpected menu: ${title}`);
                const value = selections.shift();
                const item = items.find((choice) => choice.value === value);
                assert.ok(item, `Missing selection: ${value}`);
                return item;
            },
            async input() { return "custom/snapshot"; },
        },
    } as unknown as ProjectIndexingControllerOptions);
    return {
        directory, root, controller, menus, requests, saved, finished: finished.promise,
        savedTarget(value: string | undefined) { savedTarget = value; },
        selections(values: string[]) { selections = values; },
        proposedTarget() { return menus.at(-1)?.items.find(({ value }) => value === "target")?.description; },
    };
}

test("manual indexing refreshes the checked-out branch instead of reusing a saved target", async () => {
    const f = await fixture();
    try {
        await git(f.root, "init", "--initial-branch=main");
        await git(f.root, "commit", "--allow-empty", "-m", "Fixture");
        await f.controller.configureAndStart();
        assert.equal(f.proposedTarget(), "main");
        await git(f.root, "switch", "-c", "feature/payments");
        f.selections(["cancel"]);
        await f.controller.configureAndStart();
        assert.equal(f.proposedTarget(), "feature/payments");
        f.selections(["cancel"]);
        await f.controller.configureAndStart(" release ");
        assert.equal(f.proposedTarget(), "release");
        assert.equal(await git(f.root, "branch", "--show-current"), "feature/payments");
        await assert.rejects(f.controller.configureAndStart("invalid target"), /Retrieval target/);
        await assert.rejects(f.controller.configureAndStart("live/current"), /reserved/);
        assert.deepEqual(f.requests, []);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("the selected target reaches indexing and is persisted only after a successful build", async () => {
    const f = await fixture();
    try {
        await git(f.root, "init", "--initial-branch=feature/payments");
        f.selections(["start"]);
        await f.controller.configureAndStart("release/snapshot");
        await f.finished;
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0]?.target, "release/snapshot");
        assert.equal(f.requests[0]?.root, f.root);
        assert.equal(f.saved[0]?.target, "release/snapshot");
        assert.equal(await git(f.root, "branch", "--show-current"), "feature/payments");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("branch and target completion keeps the current branch first, deduplicates, and supports slash names", async () => {
    const f = await fixture();
    try {
        await git(f.root, "init", "--initial-branch=feature/payments");
        await git(f.root, "commit", "--allow-empty", "-m", "Fixture");
        await git(f.root, "branch", "main");
        const completions = await f.controller.getTargetCompletions("");
        assert.equal(completions[0]?.value, "feature/payments");
        assert.match(completions[0]?.description ?? "", /Current Git branch/);
        assert.equal(completions.filter(({ value }) => value === "feature/payments").length, 1);
        assert.ok(completions.some(({ value }) => value === "release"));
        assert.ok(!completions.some(({ value }) => value === "live/current"));
        assert.deepEqual((await f.controller.getTargetCompletions("FEATURE/PAY")).map(({ value }) => value), ["feature/payments"]);
        const provider = new CombinedAutocompleteProvider([{
            name: "index", getArgumentCompletions: (prefix) => f.controller.getTargetCompletions(prefix),
        }], f.root);
        const line = "/index feat";
        const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
        assert.ok(suggestions?.items[0]);
        assert.deepEqual(provider.applyCompletion([line], 0, line.length, suggestions.items[0], suggestions.prefix).lines,
            ["/index feature/payments"]);
        f.selections(["target", "target:release", "cancel"]);
        await f.controller.configureAndStart();
        assert.equal(f.proposedTarget(), "release");
        f.selections(["target", "custom", "cancel"]);
        await f.controller.configureAndStart();
        assert.equal(f.proposedTarget(), "custom/snapshot");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("plain directories keep their saved target and default to main without a preference", async () => {
    const f = await fixture();
    try {
        assert.equal(await detectProjectRoot(f.root), f.root);
        assert.equal(await currentGitIndexTarget(f.root), undefined);
        assert.deepEqual(await localBranchIndexTargets(f.root), []);
        await f.controller.configureAndStart();
        assert.equal(f.proposedTarget(), "release");
        f.savedTarget(undefined);
        f.selections(["cancel"]);
        await f.controller.configureAndStart();
        assert.equal(f.proposedTarget(), "main");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Git targets handle unborn branches, detached HEAD, and unsupported or reserved branch names", async () => {
    const f = await fixture();
    try {
        await git(f.root, "init", "--initial-branch=feature/unborn");
        assert.equal((await currentGitIndexTarget(f.root))?.value, "feature/unborn");
        assert.equal((await f.controller.getTargetCompletions(""))[0]?.value, "feature/unborn");
        await git(f.root, "commit", "--allow-empty", "-m", "Fixture");
        const nested = join(f.root, "nested");
        await mkdir(nested);
        assert.equal(await realpath(await detectProjectRoot(nested)), await realpath(f.root));
        const head = await git(f.root, "rev-parse", "HEAD");
        await git(f.root, "switch", "--detach", "HEAD");
        assert.equal((await currentGitIndexTarget(f.root))?.value, `detached-${head.slice(0, 12)}`);
        for (const branch of ["feature/задача", "live/current", `long-${"x".repeat(140)}`]) {
            await git(f.root, "switch", "-c", branch);
            const current = await currentGitIndexTarget(f.root);
            assert.ok(current);
            assert.equal(normalizeRetrievalTargetName(current.value), current.value);
            assert.notEqual(current.value, "live/current");
            assert.equal((await currentGitIndexTarget(f.root))?.value, current.value);
            assert.ok((await localBranchIndexTargets(f.root)).some(({ value }) => value === current.value));
        }
        assert.throws(() => normalizeManualIndexTarget("live/current"), /reserved/);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});
