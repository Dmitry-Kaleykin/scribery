import { ProjectPreferenceStore } from "../services/preference-store.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SelectItem } from "@earendil-works/pi-tui";
import { DocumentationService, IndexingPresetService, ProviderProfileService } from "scribery";
import { editProfileSettings } from "./profile-settings.js";
import { PresetController, type PresetControllerOptions } from "./preset-controller.js";
import { DocumentationController, type DocumentationControllerOptions } from "./documentation-controller.js";
import type { FeatureUi } from "./contracts.js";

class ScriptedUi implements FeatureUi {
    readonly menus: Array<{ title: string; items: readonly SelectItem[] }> = [];
    readonly messages: string[] = [];
    readonly prompts: string[] = [];
    constructor(readonly selections: Array<string | undefined>, readonly inputs: Array<string | undefined> = []) {}
    async pick(title: string, items: readonly SelectItem[]) {
        this.menus.push({ title, items });
        assert.ok(this.selections.length, `Unexpected menu: ${title}`);
        const selected = this.selections.shift();
        if (selected === undefined) return undefined;
        const item = items.find(({ value }) => value === selected);
        assert.ok(item, `Missing ${selected} in ${title}`);
        return item;
    }
    async input(_title: string, label: string) {
        this.prompts.push(label);
        assert.ok(this.inputs.length, `Unexpected input: ${label}`);
        return this.inputs.shift();
    }
    append(message: string) { this.messages.push(message); }
    async secretInput(): Promise<string | undefined> { throw new Error("Unexpected credentials prompt"); }
    async confirm(): Promise<boolean> { throw new Error("Unexpected confirmation"); }
    async editJson(): Promise<unknown | undefined> { throw new Error("Unexpected JSON editor"); }
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "settings-editors-"));
    const profilesPath = join(directory, "profiles.json");
    const profiles = new ProviderProfileService({ profilesPath });
    const profile = await profiles.set({ name: "local", embedding: {
        provider: "openai-compatible", model: "embedding", dimensions: 1024, maximumInputs: 8,
        baseUrl: "http://localhost:1234/v1", embeddingSuffix: "suffix",
    }, reranking: { provider: "openai-compatible-qwen3", model: "reranker", instruction: "instruction", baseUrl: "http://localhost:8000/v1" },
    compression: { enabled: true, model: "2B", baseUrl: "http://localhost:9000/v1", timeoutMs: 1000, maximumFiles: 3 } });
    const presets = new IndexingPresetService({ profilesPath, presetsPath: join(directory, "presets.json") });
    const preset = await presets.set({ name: "code", providerProfile: "local", maximumChunkSize: 2345,
        windows1251: true, include: ["src/**"], exclude: ["**/vendor/**"],
    });
    return { directory, profiles, profile, presets, preset };
}

const noService = async (): Promise<ProviderProfileService> => { throw new Error("Unrelated provider inspection"); };

test("compression can be changed directly without embedding prompts or provider inspection", async () => {
    const f = await fixture();
    try {
        const ui = new ScriptedUi(["compression", "__done"]);
        await editProfileSettings({ ui, profiles: f.profiles, name: "local", providerService: noService,
            pickModel: async (_profile, kind) => { assert.equal(kind, "compression"); return "4B"; },
        });
        const saved = await f.profiles.get("local");
        assert.deepEqual(saved.embedding, f.profile.embedding);
        assert.deepEqual(saved.reranking, f.profile.reranking);
        assert.deepEqual(saved.compression, { ...f.profile.compression, model: "4B" });
        assert.deepEqual(ui.prompts, []);
        assert.equal(ui.menus[1]!.items.find(({ value }) => value === "compression")?.description, "4B");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("nested settings save individually and later edits retain the new values", async () => {
    const f = await fixture();
    try {
        const ui = new ScriptedUi(["limits", "timeoutMs", "__done", "compression", "endpoints", "compression", "__done", "__done"], ["2500", ""]);
        await editProfileSettings({ ui, profiles: f.profiles, name: "local", providerService: noService,
            pickModel: async () => "4B",
        });
        const saved = await f.profiles.get("local");
        assert.deepEqual(saved.compression, { enabled: true, model: "4B", timeoutMs: 2500, maximumFiles: 3 });
        assert.deepEqual(saved.embedding, f.profile.embedding);
        assert.deepEqual(saved.reranking, f.profile.reranking);
        assert.equal(ui.menus[2]!.items.find(({ value }) => value === "timeoutMs")?.description, "2500");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("invalid or cancelled edits never save, and the settings menu stays usable", async () => {
    const f = await fixture();
    try {
        const ui = new ScriptedUi(["limits", "timeoutMs", "maximumFiles", undefined, "compression", "__done"], ["99999", undefined]);
        await editProfileSettings({ ui, profiles: f.profiles, name: "local", providerService: noService,
            pickModel: async () => undefined,
        });
        assert.deepEqual(await f.profiles.get("local"), f.profile);
        assert.ok(ui.messages.some((message) => message.includes("timeoutMs")));
        assert.ok(!ui.messages.some((message) => message.startsWith("Updated")));
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("changing an embedding model inspects only that model and keeps the remaining settings", async () => {
    const f = await fixture();
    try {
        let inspected = 0;
        const ui = new ScriptedUi(["embedding", "__done"]);
        await editProfileSettings({ ui, profiles: f.profiles, name: "local", pickModel: async () => "new-embedding",
            providerService: async () => ({ async inspectEmbeddingModel(model: string, endpoint: string, suffix: string) {
                inspected++;
                assert.equal(model, "new-embedding"); assert.equal(endpoint, f.profile.embedding.baseUrl);
                assert.equal(suffix, "suffix"); return { dimensions: 768 };
            } } as ProviderProfileService),
        });
        const saved = await f.profiles.get("local");
        assert.equal(inspected, 1);
        assert.deepEqual(saved.embedding, { ...f.profile.embedding, model: "new-embedding", dimensions: 768 });
        assert.deepEqual(saved.compression, f.profile.compression);
        assert.deepEqual(saved.reranking, f.profile.reranking);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("preset edits expose the chosen field directly, allow clearing, and preserve other values", async () => {
    const f = await fixture();
    try {
        const ui = new ScriptedUi(["edit", "exclude", "windows1251", undefined, "chunk-size", "__done"], ["", "4567"]);
        await new PresetController(presetOptions(f, ui)).manage("code");
        const saved = await f.presets.get("code");
        assert.equal(saved.exclude, undefined);
        assert.equal(saved.maximumChunkSize, 4567);
        assert.equal(saved.windows1251, true);
        assert.deepEqual(saved.include, f.preset.include);
        assert.equal(saved.providerProfile, "local");
        assert.equal(ui.prompts.length, 2);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("preset validation failure leaves the stored preset unchanged", async () => {
    const f = await fixture();
    try {
        const ui = new ScriptedUi(["edit", "chunk-size", "__done"], ["0"]);
        await new PresetController(presetOptions(f, ui)).manage("code");
        assert.deepEqual(await f.presets.get("code"), f.preset);
        assert.ok(ui.messages.some((message) => message.includes("positive integer")));
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("documentation indexing exposes existing profile and preset independently before starting", async (t) => {
    const f = await fixture();
    try {
        await f.profiles.set({ ...f.profile, name: "other" });
        await f.presets.set({ ...f.preset, name: "other-preset" });
        t.mock.method(DocumentationService.prototype, "listDocumentations", async () => [{
            documentationId: "manual", name: "Manual", sourceDefinitionCount: 1, indexedSourceCount: 1, needsIndex: false,
        }]);
        const ui = new ScriptedUi(["manual", "index", "preset", "profile", "other", "cancel"]);
        const accessed: string[] = [];
        await new DocumentationController({
            ui, cwd: f.directory, operations: {}, profiles: f.profiles,
            providerAccess: { async profileService(name: string) { accessed.push(name); return f.profiles; } },
            presets: () => f.presets.list(), pickPreset: async () => "other-preset",
            activePreference: () => ({ preset: "code" }), searchProfile: async () => "local", liveRunning: () => false,
        } as unknown as DocumentationControllerOptions).manage();
        const menus = ui.menus.filter(({ title }) => title === "Index Manual");
        assert.equal(menus[0]?.items.find(({ value }) => value === "preset")?.description, "code");
        assert.equal(menus[1]?.items.find(({ value }) => value === "preset")?.description, "other-preset");
        assert.equal(menus[2]?.items.find(({ value }) => value === "profile")?.description, "other");
        assert.deepEqual(accessed, ["local", "other"]);
        assert.deepEqual(ui.prompts, []);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
});

function presetOptions(f: Awaited<ReturnType<typeof fixture>>, ui: FeatureUi): PresetControllerOptions {
    return {
        ui, presets: f.presets, profiles: f.profiles, liveRunning: () => false,
        pickProfile: async () => { throw new Error("Unrelated profile picker"); },
        preferences: new ProjectPreferenceStore(join(f.directory, "preferences.json")),
        project: {
            activeProject: () => undefined, activePreference: () => undefined,
            setActivePreference: () => {}, reloadActivePreference: async () => {},
        },
    };
}
