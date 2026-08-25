import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";

import type { SelectItem } from "@earendil-works/pi-tui";
import {
    managedProjectIdentifier,
    normalizeRetrievalTargetName,
    type IndexedProjectSummary,
    type IndexingPreset,
    type IndexingPresetService,
    type ProjectIndexingEvent,
    type ProviderProfileService,
} from "scribery";

import type { ProjectPreference } from "../domain/project-preferences.js";
import type { ManualOperationManager } from "../operations/manual-operation-manager.js";
import type { ProjectPreferenceStore } from "../services/preference-store.js";
import type { ProviderAccess } from "../services/provider-access.js";
import { shouldRenderIndexingProgressImmediately } from "../services/indexing-render-policy.js";
import type { TranscriptTone } from "./contracts.js";
import type { ProfileController } from "./profile-controller.js";

interface ProposedIndexConfiguration {
    projectIdentifier: string;
    root: string;
    profile: string;
    preset: string;
    target: string;
    keepReplacedBuilds: number;
    allowDirty: boolean;
    presetValue: IndexingPreset;
}

export interface ProjectIndexingUi {
    append(message: string, tone?: TranscriptTone): void;
    appendError(error: unknown): void;
    pick(title: string, items: readonly SelectItem[]): Promise<SelectItem | undefined>;
    input(title: string, label: string, initialValue?: string): Promise<string | undefined>;
    requestRender(): void;
}

export interface ProjectIndexingControllerOptions {
    cwd: string;
    ui: ProjectIndexingUi;
    operations: ManualOperationManager;
    providerAccess: ProviderAccess;
    preferences: ProjectPreferenceStore;
    profiles: ProviderProfileService;
    presets: IndexingPresetService;
    profileController: ProfileController;
    pickPreset(
        presets: readonly IndexingPreset[],
        title: string,
    ): Promise<string | undefined>;
    activeProject(): IndexedProjectSummary | undefined;
    activePreference(): ProjectPreference | undefined;
    liveRunning(): boolean;
    refreshProjects(projectIdentifier: string): Promise<void>;
}

export class ProjectIndexingController {
    readonly #cwd: string;
    readonly #ui: ProjectIndexingUi;
    readonly #operations: ManualOperationManager;
    readonly #providerAccess: ProviderAccess;
    readonly #preferences: ProjectPreferenceStore;
    readonly #profiles: ProviderProfileService;
    readonly #presets: IndexingPresetService;
    readonly #profileController: ProfileController;
    readonly #pickPreset: ProjectIndexingControllerOptions["pickPreset"];
    readonly #activeProject: () => IndexedProjectSummary | undefined;
    readonly #activePreference: () => ProjectPreference | undefined;
    readonly #liveRunning: () => boolean;
    readonly #refreshProjects: (projectIdentifier: string) => Promise<void>;

    constructor(options: ProjectIndexingControllerOptions) {
        this.#cwd = options.cwd;
        this.#ui = options.ui;
        this.#operations = options.operations;
        this.#providerAccess = options.providerAccess;
        this.#preferences = options.preferences;
        this.#profiles = options.profiles;
        this.#presets = options.presets;
        this.#profileController = options.profileController;
        this.#pickPreset = options.pickPreset;
        this.#activeProject = options.activeProject;
        this.#activePreference = options.activePreference;
        this.#liveRunning = options.liveRunning;
        this.#refreshProjects = options.refreshProjects;
    }

    async configureAndStart(): Promise<void> {
        if (this.#liveRunning()) {
            this.#ui.append("Stop live indexing with /live stop before running a manual index.", "warning");
            return;
        }
        if (this.#operations.active) {
            this.#ui.append(`An index is already running for ${basename(this.#operations.active.root)}.`, "warning");
            return;
        }
        const project = this.#activeProject();
        const preference = this.#activePreference();
        const root = project?.root ?? detectProjectRoot(this.#cwd);
        const profiles = await this.#profiles.list();
        const presets = await this.#presets.list();
        if (profiles.length === 0) {
            this.#ui.append("Create a provider profile with /profile before indexing.", "warning");
            return;
        }
        if (presets.length === 0) {
            this.#ui.append("Create an indexing preset with /preset before indexing.", "warning");
            return;
        }
        let profileName = preference?.profile;
        let presetName = preference?.preset;
        if (!profiles.some(({ name }) => name === profileName)) profileName = undefined;
        if (!presets.some(({ name }) => name === presetName)) presetName = undefined;
        if (!profileName) profileName = await this.#profileController.pickProfile(profiles, "Select provider profile");
        if (!profileName) return;
        if (!presetName) presetName = await this.#pickPreset(presets, "Select indexing preset");
        if (!presetName) return;

        let target = preference?.target ?? "main";
        while (true) {
            const action = await this.#ui.pick("Index project", [
                { value: "start", label: "Start indexing", description: `${profileName} · ${presetName} · target ${target}` },
                { value: "profile", label: "Change profile", description: profileName },
                { value: "preset", label: "Change preset", description: presetName },
                { value: "target", label: "Change target", description: target },
                { value: "cancel", label: "Cancel" },
            ]);
            if (!action || action.value === "cancel") return;
            if (action.value === "start") break;
            if (action.value === "profile") {
                profileName = await this.#profileController.pickProfile(profiles, "Select provider profile") ?? profileName;
            } else if (action.value === "preset") {
                presetName = await this.#pickPreset(presets, "Select indexing preset") ?? presetName;
            } else if (action.value === "target") {
                const selected = (await this.#ui.input("Index project", "Target", target))?.trim();
                if (selected) target = normalizeRetrievalTargetName(selected);
            }
        }
        void this.#start({
            projectIdentifier: project?.projectIdentifier ?? managedProjectIdentifier(root),
            root,
            profile: profileName,
            preset: presetName,
            target,
            keepReplacedBuilds: preference?.keepReplacedBuilds ?? 1,
            allowDirty: preference?.allowDirty ?? false,
            presetValue: presets.find(({ name }) => name === presetName)!,
        });
    }

    async #start(configuration: ProposedIndexConfiguration): Promise<void> {
        const operation = this.#operations.begin(
            configuration.root,
            `Checking profile ${configuration.profile}`,
        );
        const { controller } = operation;
        try {
            const indexingService = await this.#providerAccess.indexingService(configuration.profile);
            const outcome = await indexingService.index({
                root: configuration.root,
                provider: { type: "profile", profile: configuration.profile },
                target: configuration.target,
                keepReplacedBuilds: configuration.keepReplacedBuilds,
                ...(configuration.allowDirty ? { allowDirty: true } : {}),
                ...(configuration.presetValue.maximumChunkSize === undefined ? {} : { maximumChunkSize: configuration.presetValue.maximumChunkSize }),
                ...(configuration.presetValue.windows1251 === undefined ? {} : { windows1251: configuration.presetValue.windows1251 }),
                ...(configuration.presetValue.include === undefined ? {} : { include: configuration.presetValue.include }),
                ...(configuration.presetValue.exclude === undefined ? {} : { exclude: configuration.presetValue.exclude }),
                signal: controller.signal,
                onEvent: (event) => this.#onEvent(event),
            });
            await this.#preferences.set({
                ...configuration,
                projectIdentifier: outcome.project?.projectIdentifier ?? configuration.projectIdentifier,
            });
            this.#ui.append(
                `✓ Indexed ${basename(configuration.root)} in ${formatDuration(Date.now() - operation.startedAt)}\n` +
                `  ${outcome.result.discoveredFiles.toLocaleString()} files · ` +
                `${outcome.result.indexedChunks.toLocaleString()} chunks · ` +
                `${outcome.result.reusedEmbeddings.toLocaleString()} embeddings reused · ` +
                `build ${outcome.result.indexBuildId.slice(0, 12)}…`,
                "success",
            );
        } catch (error: unknown) {
            if (controller.signal.aborted) {
                this.#ui.append(`Indexing ${basename(configuration.root)} was cancelled.`, "warning");
            } else {
                this.#ui.appendError(error);
            }
        } finally {
            this.#operations.finish();
            await this.#refreshProjects(configuration.projectIdentifier);
            this.#ui.requestRender();
        }
    }

    #onEvent(event: ProjectIndexingEvent): void {
        const operation = this.#operations.active;
        if (!operation) return;
        if (event.type === "provider-diagnostic") {
            this.#operations.setMessage(
                event.state === "started" ? `Checking ${event.model}` : "Provider ready",
            );
        } else if (event.type === "indexing-progress") {
            this.#operations.update(
                event.progress,
                shouldRenderIndexingProgressImmediately(operation.progress, event.progress),
            );
        } else if (event.type === "target-publication") {
            this.#operations.setMessage(`Publishing target ${event.target}`);
        }
    }
}

function detectProjectRoot(cwd: string): string {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 && result.stdout.trim()
        ? resolve(result.stdout.trim())
        : cwd;
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
