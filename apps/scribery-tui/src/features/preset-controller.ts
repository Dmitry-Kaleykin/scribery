import {
    type IndexingPreset,
    type IndexingPresetInput,
    type IndexingPresetService,
    type ProviderProfile,
    type ProviderProfileService,
} from "scribery";

import type { ProjectPreferenceStore } from "../services/preference-store.js";
import type {
    ProjectPreferenceContext,
    FeatureUi,
} from "./contracts.js";

export interface PresetControllerOptions {
    ui: FeatureUi;
    project: ProjectPreferenceContext;
    preferences: ProjectPreferenceStore;
    profiles: ProviderProfileService;
    presets: IndexingPresetService;
    pickProfile(
        profiles: readonly ProviderProfile[],
        title: string,
        currentName?: string,
    ): Promise<string | undefined>;
    liveRunning(): boolean;
}

export class PresetController {
    readonly #ui: FeatureUi;
    readonly #project: ProjectPreferenceContext;
    readonly #preferences: ProjectPreferenceStore;
    readonly #profiles: ProviderProfileService;
    readonly #presets: IndexingPresetService;
    readonly #pickProfile: PresetControllerOptions["pickProfile"];
    readonly #liveRunning: () => boolean;

    constructor(options: PresetControllerOptions) {
        this.#ui = options.ui;
        this.#project = options.project;
        this.#preferences = options.preferences;
        this.#profiles = options.profiles;
        this.#presets = options.presets;
        this.#pickProfile = options.pickProfile;
        this.#liveRunning = options.liveRunning;
    }

    async manage(argument = ""): Promise<void> {
        if (this.#liveRunning()) {
            this.#ui.append("Stop live indexing before changing indexing presets.", "warning");
            return;
        }
        const presets = await this.#presets.list();
        const direct = argument ? presets.find(({ name }) => name === argument) : undefined;
        const selection = direct ? { value: direct.name, label: direct.name } : await this.#ui.pick("Indexing presets", [
            { value: "__create", label: "+ Create preset", description: "Define code indexing rules" },
            ...presets.map((preset) => ({
                value: preset.name,
                label: preset.name,
                description: presetSummary(preset),
            })),
        ]);
        if (!selection) return;
        if (selection.value === "__create") {
            await this.#create();
            return;
        }
        const preset = presets.find(({ name }) => name === selection.value)!;
        const action = await this.#ui.pick(preset.name, [
            { value: "use", label: "Use for current project" },
            { value: "edit", label: "Edit preset" },
            { value: "edit-json", label: "Edit JSON", description: "Open validated preset JSON in a terminal editor" },
            { value: "rename", label: "Rename" },
            { value: "show", label: "Show configuration" },
            { value: "delete", label: "Delete preset" },
        ]);
        if (!action) return;
        if (action.value === "use") {
            const project = this.#project.activeProject();
            const preference = this.#project.activePreference();
            if (!project || !preference) {
                this.#ui.append("Select a profile during /index before changing an existing project preset.", "warning");
                return;
            }
            this.#project.setActivePreference(await this.#preferences.set({
                ...preference,
                preset: preset.name,
            }));
            this.#ui.append(`Project preset changed to ${preset.name}.`, "success");
        } else if (action.value === "edit") {
            await this.#edit(preset);
        } else if (action.value === "edit-json") {
            await this.#editJson(preset);
        } else if (action.value === "rename") {
            await this.#rename(preset);
        } else if (action.value === "show") {
            this.#ui.append(JSON.stringify(preset, null, 2));
        } else if (action.value === "delete") {
            await this.#delete(preset);
        }
    }

    async pick(
        presets: readonly IndexingPreset[],
        title: string,
    ): Promise<string | undefined> {
        const selection = await this.#ui.pick(title, presets.map((preset) => ({
            value: preset.name,
            label: preset.name,
            description: presetSummary(preset),
        })));
        return selection?.value;
    }

    async #create(): Promise<void> {
        const name = (await this.#ui.input("Create indexing preset", "Name"))?.trim();
        if (!name) return;
        const configuration = await this.#promptConfiguration("Create indexing preset", name);
        if (configuration === undefined) return;
        const saved = await this.#presets.set(configuration);
        this.#ui.append(`Created preset ${saved.name}.`, "success");
    }

    async #edit(preset: IndexingPreset): Promise<void> {
        const configuration = await this.#promptConfiguration(`Edit ${preset.name}`, preset.name, preset);
        if (configuration === undefined) return;
        await this.#presets.set(configuration);
        this.#ui.append(`Updated preset ${preset.name}.`, "success");
    }

    async #editJson(preset: IndexingPreset): Promise<void> {
        const edited = await this.#ui.editJson(editablePreset(preset), `preset-${preset.name}`);
        if (edited === undefined) {
            this.#ui.append(`Preset ${preset.name} was not changed.`, "muted");
            return;
        }
        await this.#presets.set(requireEditedPreset(edited, preset.name));
        this.#ui.append(`Updated preset ${preset.name} from JSON.`, "success");
    }

    async #promptConfiguration(
        title: string,
        name: string,
        current?: IndexingPreset,
    ): Promise<IndexingPresetInput | undefined> {
        const profiles = await this.#profiles.list();
        if (profiles.length === 0) throw new Error("Create a provider profile before creating a preset");
        const providerProfile = await this.#pickProfile(
            profiles,
            "Select provider profile",
            current?.providerProfile ?? this.#project.activePreference()?.profile,
        );
        if (providerProfile === undefined) return undefined;
        const chunkText = await this.#ui.input(title, "Maximum chunk size", String(current?.maximumChunkSize ?? 3_000));
        if (chunkText === undefined) return undefined;
        const maximumChunkSize = parsePositiveInteger(chunkText, "Maximum chunk size");
        const includeText = await this.#ui.input(title, "Include globs (comma separated)", current?.include?.join(", ") ?? "");
        if (includeText === undefined) return undefined;
        const excludeText = await this.#ui.input(title, "Exclude globs (comma separated)", current?.exclude?.join(", ") ?? "");
        if (excludeText === undefined) return undefined;
        const windows1251 = await this.#ui.confirm("Enable Windows-1251 fallback?", current?.windows1251 === true);
        const include = splitPatterns(includeText);
        const exclude = splitPatterns(excludeText);
        return {
            name,
            providerProfile,
            maximumChunkSize,
            windows1251,
            ...(include.length === 0 ? {} : { include }),
            ...(exclude.length === 0 ? {} : { exclude }),
        };
    }

    async #rename(preset: IndexingPreset): Promise<void> {
        const nextName = (await this.#ui.input(`Rename ${preset.name}`, "New name", preset.name))?.trim();
        if (!nextName || nextName === preset.name) return;
        const renamed = await this.#presets.rename(preset.name, nextName);
        let updatedPreferences = 0;
        try {
            updatedPreferences = await this.#preferences.replacePresetReferences(preset.name, renamed.name);
        } catch (error: unknown) {
            try {
                await this.#presets.rename(renamed.name, preset.name);
            } catch (rollbackError: unknown) {
                throw new AggregateError(
                    [error, rollbackError],
                    "Preset was renamed but its references could not be fully updated or restored",
                );
            }
            throw error;
        }
        await this.#project.reloadActivePreference();
        this.#ui.append(
            `Renamed preset ${preset.name} to ${renamed.name}; updated ${updatedPreferences} TUI project preference(s).`,
            "success",
        );
    }

    async #delete(preset: IndexingPreset): Promise<void> {
        const used = (await this.#preferences.list()).filter(({ preset: value }) => value === preset.name);
        if (used.length > 0) {
            this.#ui.append(`Preset ${preset.name} is used by ${used.length} project(s) and cannot be deleted.`, "warning");
            return;
        }
        if (await this.#ui.confirm(`Delete preset ${preset.name}?`)) {
            await this.#presets.remove(preset.name);
            this.#ui.append(`Deleted preset ${preset.name}.`, "success");
        }
    }
}

function presetSummary(preset: IndexingPreset): string {
    return `${preset.maximumChunkSize ?? "default"} chars · ${preset.exclude?.length ?? 0} excludes`;
}

function editablePreset(preset: IndexingPreset): IndexingPresetInput {
    return {
        name: preset.name,
        providerProfile: preset.providerProfile,
        ...(preset.maximumChunkSize === undefined ? {} : { maximumChunkSize: preset.maximumChunkSize }),
        ...(preset.windows1251 === undefined ? {} : { windows1251: preset.windows1251 }),
        ...(preset.include === undefined ? {} : { include: [...preset.include] }),
        ...(preset.exclude === undefined ? {} : { exclude: [...preset.exclude] }),
    };
}

function requireEditedPreset(value: unknown, expectedName: string): IndexingPresetInput {
    if (!isRecord(value) || value.name !== expectedName) {
        throw new Error(`Edited preset name must remain ${expectedName}; use Rename to update references safely`);
    }
    rejectUnknownKeys(
        value,
        ["name", "providerProfile", "maximumChunkSize", "windows1251", "include", "exclude"],
        "preset",
    );
    return value as unknown as IndexingPresetInput;
}

function rejectUnknownKeys(
    value: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
    label: string,
): void {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new Error(`Edited ${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
    }
}

function parsePositiveInteger(value: string, label: string): number {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) throw new Error(`${label} must be a positive integer`);
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
    return parsed;
}

function splitPatterns(value: string): readonly string[] {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
