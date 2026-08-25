import type { SelectItem } from "@earendil-works/pi-tui";
import {
    ProviderProfileRenameService,
    ProviderProfileService,
    type OpenAiCompatibleModelSummary,
    type ProviderProfile,
    type ProviderProfileInput,
} from "scribery";

import { formatError } from "../services/error-formatter.js";
import { ProjectPreferenceStore } from "../services/preference-store.js";
import { apiKeyOptions, ProviderAccess } from "../services/provider-access.js";
import type { FeatureUi, ProjectPreferenceContext } from "./contracts.js";
import { resolveEmbeddingDimensionsInput } from "./embedding-dimensions.js";

export interface ProfileControllerOptions {
    ui: FeatureUi;
    project: ProjectPreferenceContext;
    preferences: ProjectPreferenceStore;
    providerAccess: ProviderAccess;
    profiles: ProviderProfileService;
    profileRenames: ProviderProfileRenameService;
    liveRunning(): boolean;
}

export class ProfileController {
    readonly #ui: FeatureUi;
    readonly #project: ProjectPreferenceContext;
    readonly #preferences: ProjectPreferenceStore;
    readonly #providerAccess: ProviderAccess;
    readonly #profiles: ProviderProfileService;
    readonly #profileRenames: ProviderProfileRenameService;
    readonly #liveRunning: () => boolean;

    constructor(options: ProfileControllerOptions) {
        this.#ui = options.ui;
        this.#project = options.project;
        this.#preferences = options.preferences;
        this.#providerAccess = options.providerAccess;
        this.#profiles = options.profiles;
        this.#profileRenames = options.profileRenames;
        this.#liveRunning = options.liveRunning;
    }

    async manageProfiles(argument = ""): Promise<void> {
        if (this.#liveRunning()) {
            this.#ui.append("Stop live indexing before changing provider profiles.", "warning");
            return;
        }
        const profiles = await this.#profiles.list();
        const direct = argument ? profiles.find(({ name }) => name === argument) : undefined;
        const profileItems = await Promise.all(profiles.map(async (profile) => ({
            value: profile.name,
            label: profile.name,
            description: `${profile.embedding.model} · ${profile.embedding.dimensions} dimensions · ${this.rerankingSummary(profile)} · API key ${await this.#providerAccess.apiKeySource(profile.name)}`,
        })));
        const selection = direct ? { value: direct.name, label: direct.name } : await this.#ui.pick("Provider profiles", [
            { value: "__create", label: "+ Create profile", description: "Discover an OpenAI-compatible model" },
            ...profileItems,
        ]);
        if (!selection) return;
        if (selection.value === "__create") {
            await this.#createProfile();
            return;
        }
        const profile = profiles.find(({ name }) => name === selection.value)!;
        const hasSessionApiKey = this.#providerAccess.hasSessionApiKey(profile.name);
        const credentialsAvailable = await this.#providerAccess.credentialsAvailable();
        const storedApiKey = credentialsAvailable
            ? await this.#providerAccess.storedApiKey(profile.name)
            : undefined;
        const action = await this.#ui.pick(profile.name, [
            { value: "use", label: "Use for current project" },
            ...(credentialsAvailable
                ? [{
                    value: "save-api-key",
                    label: storedApiKey === undefined
                        ? `Save API key in ${this.#providerAccess.credentialDisplayName}`
                        : `Replace API key in ${this.#providerAccess.credentialDisplayName}`,
                    description: "Persists securely across TUI launches",
                }]
                : []),
            {
                value: "session-api-key",
                label: hasSessionApiKey ? "Replace session API key" : "Use API key for this session",
                description: hasSessionApiKey
                    ? "Currently stored for this TUI session"
                    : "Kept only in memory and forgotten on exit",
            },
            ...(hasSessionApiKey
                ? [{ value: "clear-session-api-key", label: "Clear session API key", description: "Return to the saved or environment fallback" }]
                : []),
            ...(storedApiKey === undefined
                ? []
                : [{ value: "forget-api-key", label: `Forget API key in ${this.#providerAccess.credentialDisplayName}` }]),
            ...(!credentialsAvailable
                ? [{ value: "keyring-unavailable", label: `${this.#providerAccess.credentialDisplayName} unavailable`, description: "Session and environment keys still work" }]
                : []),
            { value: "test", label: "Test connection" },
            { value: "edit", label: "Edit profile" },
            { value: "edit-json", label: "Edit JSON", description: "Open validated profile JSON in a terminal editor" },
            { value: "rename", label: "Rename" },
            { value: "show", label: "Show configuration" },
            { value: "delete", label: "Delete profile" },
        ]);
        if (!action) return;
        if (action.value === "use") {
            const project = this.#project.activeProject();
            const preference = this.#project.activePreference();
            if (!project || !preference) {
                this.#ui.append("Select a preset during /index before changing an existing project profile.", "warning");
                return;
            }
            this.#project.setActivePreference(await this.#preferences.set({
                ...preference,
                profile: profile.name,
            }));
            this.#ui.append(`Project profile changed to ${profile.name}.`, "success");
        } else if (action.value === "save-api-key") {
            const apiKey = await this.#ui.secretInput(`API key for ${profile.name}`, "API key");
            if (apiKey === undefined) return;
            if (apiKey.length === 0) {
                this.#ui.append("The API key was empty; nothing changed.", "warning");
                return;
            }
            await this.#providerAccess.saveApiKey(profile.name, apiKey);
            this.#ui.append(`Saved the API key for ${profile.name} in ${this.#providerAccess.credentialDisplayName}.`, "success");
            await this.diagnoseProfile(profile.name);
        } else if (action.value === "session-api-key") {
            const apiKey = await this.#ui.secretInput(`API key for ${profile.name}`, "API key");
            if (apiKey === undefined) return;
            if (apiKey.length === 0) {
                this.#ui.append("The API key was empty; nothing changed.", "warning");
                return;
            }
            this.#providerAccess.setSessionApiKey(profile.name, apiKey);
            this.#ui.append(`API key set for ${profile.name}. It will be forgotten when this TUI exits.`, "success");
        } else if (action.value === "clear-session-api-key") {
            this.#providerAccess.clearSessionApiKey(profile.name);
            this.#ui.append(`Cleared the session API key for ${profile.name}; API key ${await this.#providerAccess.apiKeySource(profile.name)} is active.`, "success");
        } else if (action.value === "forget-api-key") {
            if (!await this.#ui.confirm(`Forget the saved API key for ${profile.name}?`)) return;
            if (!await this.#providerAccess.deleteSavedApiKey(profile.name)) {
                throw new Error(`Could not remove the saved API key for profile ${profile.name}`);
            }
            this.#ui.append(`Forgot the saved API key for ${profile.name}; API key ${await this.#providerAccess.apiKeySource(profile.name)} is active.`, "success");
        } else if (action.value === "keyring-unavailable") {
            this.#ui.append(`${this.#providerAccess.credentialDisplayName} is unavailable. Use a session key or OPENAI_COMPATIBLE_API_KEY.`, "warning");
        } else if (action.value === "test") {
            await this.diagnoseProfile(profile.name);
        } else if (action.value === "edit") {
            await this.#editProfile(profile);
        } else if (action.value === "edit-json") {
            await this.#editProfileJson(profile);
        } else if (action.value === "rename") {
            await this.#renameProfile(profile);
        } else if (action.value === "show") {
            this.#ui.append(JSON.stringify(profile, null, 2));
        } else if (action.value === "delete") {
            await this.#deleteProfile(profile);
        }
    }


    async diagnoseProfile(profileName: string): Promise<void> {
        this.#ui.append(`Testing ${profileName}…`, "muted");
        const profileService = await this.#providerAccess.profileService(profileName);
        this.#ui.append(
            JSON.stringify(await profileService.diagnose(profileName), null, 2),
            "success",
        );
    }

    async pickProfile(
        profiles: readonly ProviderProfile[],
        title: string,
        currentName?: string,
    ): Promise<string | undefined> {
        const ordered = [...profiles].sort((left, right) => {
            if (left.name === currentName) return -1;
            if (right.name === currentName) return 1;
            return left.name.localeCompare(right.name);
        });
        const selection = await this.#ui.pick(title, ordered.map((profile) => ({
            value: profile.name,
            label: profile.name,
            description: `${profile.name === currentName ? "Current · " : ""}${profile.embedding.model} · ${profile.embedding.dimensions} dimensions · ${this.rerankingSummary(profile)}`,
        })));
        return selection?.value;
    }


    rerankingSummary(profile: ProviderProfile): string {
        if (profile.reranking === undefined) return "reranking off";
        return profile.reranking.provider === "openai-compatible-rerank"
            ? "rerank /v1/rerank"
            : "rerank /v1/completions";
    }

    async #deleteProfile(profile: ProviderProfile): Promise<void> {
        const used = (await this.#preferences.list()).filter(({ profile: value }) => value === profile.name);
        if (used.length > 0) {
            this.#ui.append(`Profile ${profile.name} is used by ${used.length} project(s) and cannot be deleted.`, "warning");
            return;
        }
        if (!await this.#ui.confirm(`Delete profile ${profile.name}?`)) return;
        const savedApiKey = await this.#providerAccess.storedApiKey(profile.name);
        if (savedApiKey !== undefined && !await this.#providerAccess.deleteSavedApiKey(profile.name)) {
            throw new Error(`Could not remove the saved API key for profile ${profile.name}`);
        }
        try {
            await this.#profiles.remove(profile.name);
        } catch (error: unknown) {
            if (savedApiKey !== undefined) {
                try {
                    await this.#providerAccess.restoreSavedApiKey(profile.name, savedApiKey);
                } catch (rollbackError: unknown) {
                    throw new AggregateError(
                        [error, rollbackError],
                        "The profile could not be deleted and its saved API key could not be restored",
                    );
                }
            }
            throw error;
        }
        this.#providerAccess.forgetProfile(profile.name);
        this.#ui.append(`Deleted profile ${profile.name}.`, "success");
    }

    async #createProfile(): Promise<void> {
        const name = (await this.#ui.input("Create provider profile", "Name"))?.trim();
        if (!name) return;
        const apiKey = await this.#ui.secretInput("Create provider profile", "API key (optional)");
        if (apiKey === undefined) return;
        let apiKeyStorage: "saved" | "session" | undefined;
        if (apiKey) {
            if (await this.#providerAccess.credentialsAvailable()) {
                const storage = await this.#ui.pick("API key storage", [
                    {
                        value: "saved",
                        label: `Save in ${this.#providerAccess.credentialDisplayName}`,
                        description: "Recommended · available automatically on future launches",
                    },
                    { value: "session", label: "Use for this session", description: "Kept only in memory and forgotten on exit" },
                ]);
                if (!storage) return;
                apiKeyStorage = storage.value === "saved" ? "saved" : "session";
            } else {
                apiKeyStorage = "session";
            }
        }
        const profileService = new ProviderProfileService(
            apiKeyOptions(apiKey || this.#providerAccess.environmentApiKey),
        );
        const configuration = await this.#promptProfileConfiguration(
            "Create provider profile",
            name,
            profileService,
        );
        if (configuration === undefined) return;
        const saved = await this.#profiles.set(configuration);
        if (apiKey && apiKeyStorage === "saved") {
            try {
                await this.#providerAccess.saveApiKey(saved.name, apiKey);
            } catch (error: unknown) {
                apiKeyStorage = "session";
                this.#providerAccess.setSessionApiKey(saved.name, apiKey);
                this.#ui.append(
                    `Could not save the API key in ${this.#providerAccess.credentialDisplayName}; using it for this session instead. ${formatError(error)}`,
                    "warning",
                );
            }
        } else if (apiKey) {
            this.#providerAccess.setSessionApiKey(saved.name, apiKey);
        }
        this.#ui.append(`Created profile ${saved.name} with ${saved.embedding.dimensions} dimensions.`, "success");
        if (apiKey && apiKeyStorage === "session" && !await this.#providerAccess.credentialsAvailable()) {
            this.#ui.append(`${this.#providerAccess.credentialDisplayName} is unavailable; the API key will be forgotten when this TUI exits.`, "warning");
        }
    }

    async #editProfile(profile: ProviderProfile): Promise<void> {
        const profileService = await this.#providerAccess.profileService(profile.name);
        const configuration = await this.#promptProfileConfiguration(
            `Edit ${profile.name}`,
            profile.name,
            profileService,
            profile,
        );
        if (configuration === undefined) return;
        await this.#profiles.set(configuration);
        this.#ui.append(`Updated profile ${profile.name}.`, "success");
    }

    async #editProfileJson(profile: ProviderProfile): Promise<void> {
        const edited = await this.#ui.editJson(editableProfile(profile), `profile-${profile.name}`);
        if (edited === undefined) {
            this.#ui.append(`Profile ${profile.name} was not changed.`, "muted");
            return;
        }
        await this.#profiles.set(requireEditedProfile(edited, profile.name));
        this.#ui.append(`Updated profile ${profile.name} from JSON.`, "success");
    }

    async #promptProfileConfiguration(
        title: string,
        name: string,
        profileService: ProviderProfileService,
        current?: ProviderProfile,
    ): Promise<ProviderProfileInput | undefined> {
        const baseUrlInput = await this.#ui.input(
            title,
            "OpenAI-compatible base URL",
            current?.embedding.baseUrl ?? "http://127.0.0.1:1234/v1",
        );
        if (baseUrlInput === undefined) return undefined;
        const baseUrl = baseUrlInput.trim();
        const models = await this.#discoverProviderModels(profileService, baseUrl || undefined, current);
        const embeddingModel = await this.#pickProviderModel("Select embedding model", models, current?.embedding.model);
        if (typeof embeddingModel !== "string") return undefined;
        const embeddingSuffix = await this.#ui.input(
            title,
            "Embedding suffix (empty uses none)",
            current?.embedding.embeddingSuffix ?? "",
        );
        if (embeddingSuffix === undefined) return undefined;
        this.#ui.append(`Inspecting embedding model ${embeddingModel}…`, "muted");
        let detectedDimensions: number;
        try {
            detectedDimensions = (await profileService.inspectEmbeddingModel(
                embeddingModel,
                baseUrl || undefined,
                embeddingSuffix || undefined,
            )).dimensions;
        } catch (error: unknown) {
            const unchanged = current !== undefined &&
                embeddingModel === current.embedding.model &&
                baseUrl === (current.embedding.baseUrl ?? "http://127.0.0.1:1234/v1") &&
                embeddingSuffix === (current.embedding.embeddingSuffix ?? "");
            if (!unchanged) throw error;
            detectedDimensions = current.embedding.dimensions;
            this.#ui.append(
                `Could not inspect the unchanged embedding model; retaining ${detectedDimensions} dimensions. ${formatError(error)}`,
                "warning",
            );
        }
        const dimensionsText = await this.#ui.input(
            title,
            `Embedding dimensions (auto = ${detectedDimensions})`,
            "auto",
        );
        if (dimensionsText === undefined) return undefined;
        const dimensions = resolveEmbeddingDimensionsInput(
            dimensionsText,
            detectedDimensions,
        );
        const maximumInputsText = await this.#ui.input(
            title,
            "Embedding batch size (empty uses default)",
            current?.embedding.maximumInputs === undefined ? "" : String(current.embedding.maximumInputs),
        );
        if (maximumInputsText === undefined) return undefined;
        const maximumInputs = parseOptionalPositiveInteger(maximumInputsText, "Embedding batch size");
        const rerankingModel = await this.#pickProviderModel(
            "Select reranker model",
            models,
            current?.reranking?.model,
            true,
        );
        if (rerankingModel === undefined) return undefined;

        let reranking: ProviderProfileInput["reranking"];
        if (rerankingModel !== null) {
            const provider = await this.#pickRerankingInterface(current?.reranking?.provider);
            if (provider === undefined) return undefined;
            if (provider === "openai-compatible-rerank") {
                reranking = { provider, model: rerankingModel, ...(baseUrl ? { baseUrl } : {}) };
            } else {
                const currentInstruction = current?.reranking !== undefined &&
                        current.reranking.provider !== "openai-compatible-rerank"
                    ? current.reranking.instruction
                    : undefined;
                const instruction = await this.#ui.input(
                    title,
                    "Reranker instruction (empty uses default)",
                    currentInstruction ?? "",
                );
                if (instruction === undefined) return undefined;
                reranking = {
                    provider,
                    model: rerankingModel,
                    ...(baseUrl ? { baseUrl } : {}),
                    ...(instruction.trim().length === 0 ? {} : { instruction: instruction.trim() }),
                };
            }
        }
        return {
            name,
            embedding: {
                provider: "openai-compatible",
                model: embeddingModel,
                dimensions,
                ...(baseUrl ? { baseUrl } : {}),
                ...(maximumInputs === undefined ? {} : { maximumInputs }),
                ...(embeddingSuffix.length === 0 ? {} : { embeddingSuffix }),
            },
            ...(reranking === undefined ? {} : { reranking }),
        };
    }

    async #discoverProviderModels(
        profileService: ProviderProfileService,
        baseUrl: string | undefined,
        current?: ProviderProfile,
    ): Promise<readonly OpenAiCompatibleModelSummary[]> {
        this.#ui.append("Discovering provider models…", "muted");
        try {
            const models = await profileService.listProviderModels(baseUrl);
            if (models.length === 0) throw new Error("The provider did not return any models");
            return models;
        } catch (error: unknown) {
            if (current === undefined) throw error;
            this.#ui.append(
                `Could not refresh provider models; current model IDs and manual entry remain available. ${formatError(error)}`,
                "warning",
            );
            return [
                { id: current.embedding.model },
                ...(current.reranking === undefined ? [] : [{ id: current.reranking.model }]),
            ];
        }
    }

    async #pickProviderModel(
        title: string,
        models: readonly OpenAiCompatibleModelSummary[],
        currentModel?: string,
        allowDisabled = false,
    ): Promise<string | null | undefined> {
        const unique = [...new Map(models.map((model) => [model.id, model])).values()];
        if (currentModel !== undefined && !unique.some(({ id }) => id === currentModel)) {
            unique.push({ id: currentModel });
        }
        unique.sort((left, right) => {
            if (left.id === currentModel) return -1;
            if (right.id === currentModel) return 1;
            return left.id.localeCompare(right.id);
        });
        const items: SelectItem[] = [];
        if (allowDisabled && currentModel === undefined) {
            items.push({ value: "__disabled", label: "Disable reranking", description: "Current" });
        }
        unique.forEach((model, index) => {
            const description = [model.id === currentModel ? "Current" : undefined, model.ownedBy]
                .filter(Boolean)
                .join(" · ");
            items.push({
                value: `model:${index}`,
                label: model.id,
                ...(description.length === 0 ? {} : { description }),
            });
        });
        if (allowDisabled && currentModel !== undefined) {
            items.push({ value: "__disabled", label: "Disable reranking" });
        }
        items.push({ value: "__manual", label: "Enter model ID manually", description: "Use an ID absent from provider discovery" });
        const selection = await this.#ui.pick(title, items);
        if (selection === undefined) return undefined;
        if (selection.value === "__disabled") return null;
        if (selection.value === "__manual") {
            const manual = (await this.#ui.input(title, "Model ID", currentModel ?? ""))?.trim();
            if (manual === undefined) return undefined;
            if (manual.length === 0) throw new Error("Model ID must not be empty");
            return manual;
        }
        return unique[Number.parseInt(selection.value.slice("model:".length), 10)]?.id;
    }

    async #pickRerankingInterface(
        currentProvider?: NonNullable<ProviderProfile["reranking"]>["provider"],
    ): Promise<"openai-compatible-rerank" | "openai-compatible-qwen3" | undefined> {
        const current = currentProvider === "openai-compatible-rerank"
            ? "openai-compatible-rerank"
            : currentProvider === undefined ? undefined : "openai-compatible-qwen3";
        const dedicated: SelectItem = {
            value: "openai-compatible-rerank",
            label: "Dedicated /v1/rerank",
            description: current === "openai-compatible-rerank" ? "Current · recommended for oMLX" : "Recommended for oMLX",
        };
        const completions: SelectItem = {
            value: "openai-compatible-qwen3",
            label: "Legacy /v1/completions",
            description: current === "openai-compatible-qwen3" ? "Current · Qwen3 yes/no next-token scoring" : "Qwen3 yes/no next-token scoring",
        };
        const selection = await this.#ui.pick(
            "Reranking interface",
            current === "openai-compatible-qwen3" ? [completions, dedicated] : [dedicated, completions],
        );
        return selection?.value === "openai-compatible-rerank" ||
            selection?.value === "openai-compatible-qwen3"
            ? selection.value
            : undefined;
    }

    async #renameProfile(profile: ProviderProfile): Promise<void> {
        const nextName = (await this.#ui.input(`Rename ${profile.name}`, "New name", profile.name))?.trim();
        if (!nextName || nextName === profile.name) return;
        const savedApiKey = await this.#providerAccess.storedApiKey(profile.name);
        const result = await this.#profileRenames.rename(profile.name, nextName);
        let updatedPreferences = 0;
        let preferencesUpdated = false;
        try {
            updatedPreferences = await this.#preferences.replaceProfileReferences(profile.name, result.profile.name);
            preferencesUpdated = true;
            if (savedApiKey !== undefined && !await this.#providerAccess.renameSavedApiKey(profile.name, result.profile.name)) {
                throw new Error(`Could not move the saved API key for profile ${profile.name}`);
            }
        } catch (error: unknown) {
            const rollbackErrors: unknown[] = [error];
            if (preferencesUpdated) {
                try {
                    await this.#preferences.replaceProfileReferences(result.profile.name, profile.name);
                } catch (rollbackError: unknown) {
                    rollbackErrors.push(rollbackError);
                }
            }
            try {
                await this.#profileRenames.rename(result.profile.name, profile.name);
            } catch (rollbackError: unknown) {
                rollbackErrors.push(rollbackError);
            }
            if (rollbackErrors.length > 1) {
                throw new AggregateError(
                    rollbackErrors,
                    "Profile was renamed but its references could not be fully updated or restored",
                );
            }
            throw error;
        }
        this.#providerAccess.moveSessionApiKey(profile.name, result.profile.name);
        await this.#project.reloadActivePreference();
        this.#ui.append(
            `Renamed profile ${profile.name} to ${result.profile.name}; updated ${result.updatedPresets} preset(s), ${result.updatedProjectRecipes} project recipe(s), and ${updatedPreferences} TUI project preference(s).`,
            "success",
        );
    }


}

function editableProfile(profile: ProviderProfile): ProviderProfileInput {
    return {
        name: profile.name,
        embedding: { ...profile.embedding },
        ...(profile.reranking === undefined ? {} : { reranking: { ...profile.reranking } }),
    };
}


function requireEditedProfile(value: unknown, expectedName: string): ProviderProfileInput {
    if (!isRecord(value) || value.name !== expectedName) {
        throw new Error(`Edited profile name must remain ${expectedName}; use Rename to update references safely`);
    }
    rejectUnknownKeys(value, ["name", "embedding", "reranking"], "profile");
    if (isRecord(value.embedding)) {
        rejectUnknownKeys(
            value.embedding,
            ["provider", "model", "dimensions", "baseUrl", "maximumInputs", "embeddingSuffix"],
            "profile embedding",
        );
    }
    if (isRecord(value.reranking)) {
        rejectUnknownKeys(value.reranking, ["provider", "model", "baseUrl", "instruction"], "profile reranking");
    }
    return value as unknown as ProviderProfileInput;
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

function parseOptionalPositiveInteger(value: string, label: string): number | undefined {
    return value.trim().length === 0 ? undefined : parsePositiveInteger(value, label);
}


function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
