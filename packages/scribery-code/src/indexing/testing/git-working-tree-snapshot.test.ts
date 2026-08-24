import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

import { DeterministicFakeEmbeddingProvider } from "scribery-core";
import { InMemoryStorageProvider } from "scribery-core";
import { IndexingCoordinator } from "../index.js";

const execute = promisify(execFile);

it("gives each dirty Git working-tree state an exact snapshot identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "scribery-git-snapshot-"));
    const sourcePath = join(root, "source.ts");
    await execute("git", ["init", "-q", root]);
    await execute("git", ["-C", root, "config", "user.name", "Fixture"]);
    await execute("git", ["-C", root, "config", "user.email", "fixture@example.test"]);
    await writeFile(sourcePath, "export const value = 1;\n");
    await execute("git", ["-C", root, "add", "source.ts"]);
    await execute("git", ["-C", root, "commit", "-q", "-m", "fixture"]);

    const storage = new InMemoryStorageProvider();
    const coordinator = new IndexingCoordinator(
        storage,
        new DeterministicFakeEmbeddingProvider(8),
    );
    const committed = await coordinator.index({ root });
    const canonicalRoot = await realpath(root);
    assert.deepEqual(
        (await storage.getBuild(committed.indexBuildId))?.sourceProvenance,
        {
            kind: "git-working-tree",
            root: canonicalRoot,
            repositoryRoot: canonicalRoot,
            headCommit: (
                await execute("git", ["-C", root, "rev-parse", "HEAD"])
            ).stdout.trim(),
            refName: (
                await execute(
                    "git",
                    ["-C", root, "symbolic-ref", "--short", "HEAD"],
                )
            ).stdout.trim(),
            dirty: false,
        },
    );

    await writeFile(sourcePath, "export const value = 2;\n");
    await assert.rejects(
        coordinator.index({ root }),
        (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "dirty-working-tree",
    );
    const firstDirty = await coordinator.index({ root, allowDirty: true });
    const dirtyProvenance = (await storage.getBuild(firstDirty.indexBuildId))
        ?.sourceProvenance;
    assert.equal(dirtyProvenance?.kind, "git-working-tree");
    assert.equal(
        dirtyProvenance?.kind === "git-working-tree"
            ? dirtyProvenance.dirty
            : undefined,
        true,
    );
    await writeFile(sourcePath, "export const value = 3;\n");
    const secondDirty = await coordinator.index({ root, allowDirty: true });

    assert.equal(committed.reused, false);
    assert.equal(firstDirty.reused, false);
    assert.equal(secondDirty.reused, false);
    assert.notEqual(firstDirty.snapshotId, committed.snapshotId);
    assert.notEqual(secondDirty.snapshotId, firstDirty.snapshotId);
    assert.notEqual(secondDirty.indexBuildId, firstDirty.indexBuildId);
});
