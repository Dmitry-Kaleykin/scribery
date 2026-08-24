import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
    IndexingPresetService,
    ProviderProfileService,
} from "../index.js";

describe("indexing presets", () => {
    it("creates, updates, lists, and removes reusable indexing defaults", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-presets-"));
        const profilesPath = join(directory, "provider-profiles.json");
        const presetsPath = join(directory, "indexing-presets.json");
        await new ProviderProfileService({ profilesPath }).set({
            name: "local-qwen",
            embedding: {
                provider: "lm-studio",
                model: "qwen-embedding",
                dimensions: 1_024,
            },
        });
        const service = new IndexingPresetService({
            profilesPath,
            presetsPath,
        });
        const created = await service.set({
            name: "legacy-web",
            providerProfile: "local-qwen",
            maximumChunkSize: 3_000,
            windows1251: true,
            include: ["src/**", "src/**"],
            exclude: ["vendor/**"],
        });

        assert.equal(created.name, "legacy-web");
        assert.equal(created.providerProfile, "local-qwen");
        assert.deepEqual(created.include, ["src/**"]);
        assert.equal((await service.list()).length, 1);
        assert.deepEqual(await service.get("legacy-web"), created);

        const updated = await service.set({
            name: "legacy-web",
            providerProfile: "local-qwen",
            maximumChunkSize: 1_500,
        });
        assert.equal(updated.createdAt, created.createdAt);
        assert.equal(updated.maximumChunkSize, 1_500);
        assert.equal(updated.windows1251, undefined);
        assert.equal(updated.include, undefined);

        const renamed = await service.rename("legacy-web", "modern-web");
        assert.equal(renamed.name, "modern-web");
        assert.equal(renamed.createdAt, created.createdAt);
        await assert.rejects(service.get("legacy-web"), /was not found/u);
        await service.set({
            name: "other",
            providerProfile: "local-qwen",
        });
        await assert.rejects(
            service.rename("modern-web", "other"),
            /already exists/u,
        );
        await service.remove("other");

        assert.deepEqual(await service.remove("modern-web"), {
            removed: "modern-web",
            presetCount: 0,
        });
        await assert.rejects(service.get("modern-web"), /was not found/u);
    });

    it("requires an existing provider profile and validates settings", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-presets-"));
        const service = new IndexingPresetService({
            profilesPath: join(directory, "provider-profiles.json"),
            presetsPath: join(directory, "indexing-presets.json"),
        });

        await assert.rejects(
            service.set({
                name: "missing-provider",
                providerProfile: "unknown",
            }),
            /Provider profile unknown was not found/u,
        );
        assert.equal((await service.list()).length, 0);
    });
});
