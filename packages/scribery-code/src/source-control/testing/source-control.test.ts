import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
    GitSourceControlProvider,
    inspectSourceState,
} from "../index.js";

const execute = promisify(execFile);

describe("source control", () => {
    it("treats a non-Git root as a plain directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "scribery-plain-"));
        const state = await inspectSourceState(root, {
            repositoryIdentity: "plain-fixture",
        });

        assert.equal(state.kind, "plain-directory");
    });

    it("reports clean and dirty Git state without global configuration", async () => {
        const root = await mkdtemp(join(tmpdir(), "scribery-git-"));
        await execute("git", ["init", "-q", root]);
        await execute("git", ["-C", root, "config", "user.name", "Fixture"]);
        await execute("git", ["-C", root, "config", "user.email", "fixture@example.test"]);
        await writeFile(join(root, "tracked.ts"), "export const value = 1;\n");
        await execute("git", ["-C", root, "add", "tracked.ts"]);
        await execute("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
        await mkdir(join(root, "src"));

        const provider = new GitSourceControlProvider();
        const context = await provider.detect(join(root, "src"), {
            repositoryIdentity: "git-fixture",
        });
        assert.ok(context);
        const clean = await provider.resolveCurrentState(context);
        assert.equal(clean.dirty, false);
        assert.ok(clean.headCommit);
        assert.equal(context.indexingRootRelativePath, "src");

        await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");
        const dirty = await provider.resolveCurrentState(context);
        assert.equal(dirty.dirty, true);
        assert.equal(dirty.changes[0]?.kind, "modified");
    });
});
