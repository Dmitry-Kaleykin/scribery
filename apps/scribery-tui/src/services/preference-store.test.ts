import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectPreferenceStore } from "./preference-store.js";

test("stores one external preference per project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scribery-tui-preferences-"));
    const path = join(directory, "preferences.json");
    const store = new ProjectPreferenceStore(path);

    await store.set({
        projectIdentifier: "abc",
        root: "/work/project",
        profile: "local",
        preset: "code",
    });
    await store.set({
        projectIdentifier: "abc",
        root: "/work/project",
        profile: "larger",
        preset: "code",
        target: "release",
    });

    const projects = await store.list();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.profile, "larger");
    assert.equal(projects[0]?.target, "release");
    assert.equal((JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number }).schemaVersion, 1);
});

test("replaces profile and preset references for every affected project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scribery-tui-preferences-"));
    const store = new ProjectPreferenceStore(join(directory, "preferences.json"));
    await store.set({
        projectIdentifier: "one",
        root: "/work/one",
        profile: "old-profile",
        preset: "old-preset",
    });
    await store.set({
        projectIdentifier: "two",
        root: "/work/two",
        profile: "other-profile",
        preset: "old-preset",
    });

    assert.equal(
        await store.replaceProfileReferences("old-profile", "new-profile"),
        1,
    );
    assert.equal(
        await store.replacePresetReferences("old-preset", "new-preset"),
        2,
    );
    const projects = await store.list();
    assert.equal(projects.find(({ projectIdentifier }) =>
        projectIdentifier === "one")?.profile, "new-profile");
    assert.ok(projects.every(({ preset }) => preset === "new-preset"));
});
