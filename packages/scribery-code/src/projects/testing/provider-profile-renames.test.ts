import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    IndexingPresetService,
    ProviderProfileService,
} from "scribery-core";
import {
    ProjectIndexingRecipeCatalog,
    ProviderProfileRenameService,
} from "../index.js";

test("renames a profile and every managed core reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scribery-profile-rename-"));
    const profilesPath = join(directory, "provider-profiles.json");
    const presetsPath = join(directory, "indexing-presets.json");
    const indexesDirectory = join(directory, "indexes");
    const profiles = new ProviderProfileService({ profilesPath });
    const created = await profiles.set({
        name: "old-profile",
        embedding: {
            provider: "openai-compatible",
            model: "embedding",
            dimensions: 3,
        },
    });
    const presets = new IndexingPresetService({ profilesPath, presetsPath });
    await presets.set({
        name: "code",
        providerProfile: "old-profile",
    });
    const projectIdentifier = "a".repeat(24);
    const recipes = new ProjectIndexingRecipeCatalog(indexesDirectory);
    await recipes.write(projectIdentifier, {
        provider: { type: "profile", profile: "old-profile" },
        target: "main",
        keepReplacedBuilds: 1,
    });

    const result = await new ProviderProfileRenameService({
        profilesPath,
        presetsPath,
        indexesDirectory,
    }).rename("old-profile", "new-profile");

    assert.equal(result.profile.name, "new-profile");
    assert.equal(result.profile.createdAt, created.createdAt);
    assert.equal(result.updatedPresets, 1);
    assert.equal(result.updatedProjectRecipes, 1);
    await assert.rejects(profiles.get("old-profile"), /was not found/u);
    assert.equal((await presets.get("code")).providerProfile, "new-profile");
    const recipe = await recipes.read(projectIdentifier);
    assert.deepEqual(recipe?.provider, {
        type: "profile",
        profile: "new-profile",
    });
});

test("rejects a profile rename collision before changing references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scribery-profile-rename-"));
    const profilesPath = join(directory, "provider-profiles.json");
    const profiles = new ProviderProfileService({ profilesPath });
    for (const name of ["first", "second"]) {
        await profiles.set({
            name,
            embedding: {
                provider: "openai-compatible",
                model: "embedding",
                dimensions: 3,
            },
        });
    }

    await assert.rejects(
        new ProviderProfileRenameService({ profilesPath }).rename(
            "first",
            "second",
        ),
        /already exists/u,
    );
    assert.deepEqual(
        (await profiles.list()).map(({ name }) => name),
        ["first", "second"],
    );
});
