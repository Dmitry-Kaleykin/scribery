import { basename } from "node:path";

import type { SelectItem } from "@earendil-works/pi-tui";
import {
    ProjectLiveIndexingService,
    type IndexedProjectSummary,
    type IndexingPreset,
    type IndexingPresetService,
    type IndexingProgress,
    type ProjectIndexingEvent,
    type ProjectLiveIndexingEvent,
    type ProjectLiveIndexingStatus,
    type ProviderProfileService,
} from "scribery";

import type { ProjectPreference } from "../domain/project-preferences.js";
import type { ManualOperationManager } from "../operations/manual-operation-manager.js";
import type { ProjectPreferenceStore } from "../services/preference-store.js";
import { apiKeyOptions, type ProviderAccess } from "../services/provider-access.js";
import { shouldRenderIndexingProgressImmediately } from "../services/indexing-render-policy.js";
import {
    shouldAnnounceLiveReady,
    type LiveReadyIdentity,
} from "../services/live-notification-policy.js";
import type { ProgressPresenter } from "../ui/progress-presenter.js";
import type { TranscriptTone } from "./contracts.js";
import type { ProfileController } from "./profile-controller.js";

interface ProposedLiveConfiguration {
    projectIdentifier: string;
    root: string;
    profile: string;
    preset: string;
    keepReplacedBuilds: number;
    presetValue: IndexingPreset;
}

export interface LiveIndexingUi {
    append(message: string, tone?: TranscriptTone): void;
    appendError(error: unknown): void;
    pick(title: string, items: readonly SelectItem[]): Promise<SelectItem | undefined>;
    updateHeader(): void;
}

export interface LiveIndexingControllerOptions {
    ui: LiveIndexingUi;
    operations: ManualOperationManager;
    progress: ProgressPresenter;
    preferences: ProjectPreferenceStore;
    providerAccess: ProviderAccess;
    profiles: ProviderProfileService;
    presets: IndexingPresetService;
    profileController: ProfileController;
    pickPreset(
        presets: readonly IndexingPreset[],
        title: string,
    ): Promise<string | undefined>;
    activeProject(): IndexedProjectSummary | undefined;
    activePreference(): ProjectPreference | undefined;
    refreshProjects(projectIdentifier: string): Promise<void>;
    terminalSuspended(): boolean;
}

export class LiveIndexingController {
    readonly #ui: LiveIndexingUi;
    readonly #operations: ManualOperationManager;
    readonly #progress: ProgressPresenter;
    readonly #preferences: ProjectPreferenceStore;
    readonly #providerAccess: ProviderAccess;
    readonly #profiles: ProviderProfileService;
    readonly #presets: IndexingPresetService;
    readonly #profileController: ProfileController;
    readonly #pickPreset: LiveIndexingControllerOptions["pickPreset"];
    readonly #activeProject: () => IndexedProjectSummary | undefined;
    readonly #activePreference: () => ProjectPreference | undefined;
    readonly #refreshProjects: (projectIdentifier: string) => Promise<void>;
    readonly #terminalSuspended: () => boolean;
    #service: ProjectLiveIndexingService | undefined;
    #status: ProjectLiveIndexingStatus | undefined;
    #liveConfiguration: ProposedLiveConfiguration | undefined;
    #indexingProgress: IndexingProgress | undefined;
    #lastReadyPublication: string | undefined;
    #lastReadyIdentity: LiveReadyIdentity | undefined;
    #lastFailure: string | undefined;
    #publicationChain: Promise<void> = Promise.resolve();

    constructor(options: LiveIndexingControllerOptions) {
        this.#ui = options.ui;
        this.#operations = options.operations;
        this.#progress = options.progress;
        this.#preferences = options.preferences;
        this.#providerAccess = options.providerAccess;
        this.#profiles = options.profiles;
        this.#presets = options.presets;
        this.#profileController = options.profileController;
        this.#pickPreset = options.pickPreset;
        this.#activeProject = options.activeProject;
        this.#activePreference = options.activePreference;
        this.#refreshProjects = options.refreshProjects;
        this.#terminalSuspended = options.terminalSuspended;
    }

    get running(): boolean {
        return this.#service?.running === true;
    }

    get status(): ProjectLiveIndexingStatus | undefined {
        return this.#status;
    }

    async manage(argument = ""): Promise<void> {
        const requestedAction = argument.toLowerCase();
        if (requestedAction === "status") {
            this.showStatus();
            return;
        }
        if (requestedAction === "stop") {
            await this.stop();
            return;
        }
        if (requestedAction === "reconcile") {
            this.reconcile();
            return;
        }
        if (requestedAction && requestedAction !== "start") {
            throw new Error("Usage: /live [start|status|reconcile|stop]");
        }
        if (this.running) {
            const action = await this.#ui.pick("Live indexing", [
                { value: "status", label: "Show status", description: this.#status?.phase ?? "starting" },
                { value: "reconcile", label: "Index now", description: "Reconcile without waiting for another file event" },
                { value: "stop", label: "Stop live indexing", description: "Keep the last published branch target" },
            ]);
            if (action?.value === "status") this.showStatus();
            else if (action?.value === "reconcile") this.reconcile();
            else if (action?.value === "stop") await this.stop();
            return;
        }
        if (this.#operations.running) {
            this.#ui.append("Wait for the current indexing operation to finish before starting live mode.", "warning");
            return;
        }
        const project = this.#activeProject();
        if (!project?.root) {
            this.#ui.append("Create the first project index with /index before starting live mode.", "warning");
            return;
        }
        const profiles = await this.#profiles.list();
        const presets = await this.#presets.list();
        if (profiles.length === 0 || presets.length === 0) {
            this.#ui.append("Live indexing needs an existing provider profile and indexing preset.", "warning");
            return;
        }
        const preference = this.#activePreference();
        let profileName = profiles.some(({ name }) => name === preference?.profile)
            ? preference!.profile
            : undefined;
        let presetName = presets.some(({ name }) => name === preference?.preset)
            ? preference!.preset
            : undefined;
        if (!profileName) profileName = await this.#profileController.pickProfile(profiles, "Select live indexing profile");
        if (!profileName) return;
        if (!presetName) presetName = await this.#pickPreset(presets, "Select live indexing preset");
        if (!presetName) return;

        while (true) {
            const action = await this.#ui.pick("Start live indexing", [
                { value: "start", label: "Start live indexing", description: `${profileName} · ${presetName}` },
                { value: "profile", label: "Change profile", description: profileName },
                { value: "preset", label: "Change preset", description: presetName },
                { value: "cancel", label: "Cancel" },
            ]);
            if (!action || action.value === "cancel") return;
            if (action.value === "start") break;
            if (action.value === "profile") {
                profileName = await this.#profileController.pickProfile(profiles, "Select live indexing profile", profileName) ?? profileName;
            } else if (action.value === "preset") {
                presetName = await this.#pickPreset(presets, "Select live indexing preset") ?? presetName;
            }
        }
        void this.#start({
            projectIdentifier: project.projectIdentifier,
            root: project.root,
            profile: profileName,
            preset: presetName,
            keepReplacedBuilds: preference?.keepReplacedBuilds ?? 1,
            presetValue: presets.find(({ name }) => name === presetName)!,
        });
    }

    reconcile(): void {
        const service = this.#service;
        if (!service?.running) {
            this.#ui.append("Live indexing is not running in this TUI.", "muted");
            return;
        }
        this.#ui.append("Live reconciliation requested.", "muted");
        void service.reconcile().catch((error: unknown) => this.#ui.appendError(error));
    }

    async stop(announce = true): Promise<void> {
        const service = this.#service;
        if (!service?.running) {
            if (announce) this.#ui.append("Live indexing is not running in this TUI.", "muted");
            return;
        }
        await service.stop();
        await this.#publicationChain;
        if (this.#service === service) {
            this.#service = undefined;
            this.#liveConfiguration = undefined;
            this.#indexingProgress = undefined;
        }
        this.#progress.stop();
        this.#ui.updateHeader();
        if (announce) {
            this.#ui.append("Live indexing stopped. The last ready branch target remains available.", "success");
        }
    }

    showStatus(): void {
        const status = this.#status;
        if (status === undefined || status.phase === "stopped") {
            this.#ui.append("Live indexing is not running in this TUI.", "muted");
            return;
        }
        this.#ui.append([
            `Live indexing ${status.phase}`,
            `Project: ${status.root}`,
            `Branch: ${status.branch ?? "unknown"}`,
            `Target: ${status.target ?? "pending"}`,
            `Build: ${status.indexBuildId?.slice(0, 12) ?? "pending"}`,
            `Updated: ${relativeTime(status.updatedAt)}`,
        ].join("\n"));
    }

    restorePresentation(): void {
        const status = this.#status;
        if (
            status?.phase === "pending" ||
            status?.phase === "indexing" ||
            status?.phase === "starting"
        ) {
            this.#ensureProgress(status);
        } else if (this.running) {
            this.#progress.stop();
        }
    }

    async #start(configuration: ProposedLiveConfiguration): Promise<void> {
        const service = new ProjectLiveIndexingService(
            apiKeyOptions(await this.#providerAccess.apiKey(configuration.profile)),
        );
        this.#service = service;
        this.#liveConfiguration = configuration;
        this.#status = undefined;
        this.#indexingProgress = undefined;
        this.#lastReadyPublication = undefined;
        this.#lastReadyIdentity = undefined;
        this.#lastFailure = undefined;
        this.#ui.append(
            `Starting live indexing for ${basename(configuration.root)}. The current Git branch will publish to live/<branch>.`,
            "muted",
        );
        this.#ui.updateHeader();
        try {
            await service.start({
                root: configuration.root,
                projectReference: configuration.projectIdentifier,
                provider: { type: "profile", profile: configuration.profile },
                keepReplacedBuilds: configuration.keepReplacedBuilds,
                ...(configuration.presetValue.maximumChunkSize === undefined ? {} : { maximumChunkSize: configuration.presetValue.maximumChunkSize }),
                ...(configuration.presetValue.windows1251 === undefined ? {} : { windows1251: configuration.presetValue.windows1251 }),
                ...(configuration.presetValue.include === undefined ? {} : { include: configuration.presetValue.include }),
                ...(configuration.presetValue.exclude === undefined ? {} : { exclude: configuration.presetValue.exclude }),
                onEvent: (event) => this.#onEvent(event),
            });
        } catch (error: unknown) {
            if (this.#service === service) {
                await service.stop().catch(() => {});
                this.#service = undefined;
                this.#liveConfiguration = undefined;
                this.#progress.stop();
                this.#ui.updateHeader();
            }
            this.#ui.appendError(error);
        }
    }

    #onEvent(event: ProjectLiveIndexingEvent): void {
        if (event.type === "indexing") {
            this.#onIndexingEvent(event.event);
            return;
        }
        const status = event.status;
        this.#status = status;
        if (status.phase === "pending") this.#indexingProgress = undefined;
        if (!this.#terminalSuspended()) {
            if (status.phase === "pending" || status.phase === "indexing" || status.phase === "starting") {
                this.#ensureProgress(status);
            } else {
                this.#progress.stop();
            }
        }
        if (status.phase === "ready" && status.indexBuildId !== undefined) {
            this.#publicationChain = this.#publicationChain
                .catch(() => {})
                .then(() => this.#acceptReady(status))
                .catch((error: unknown) => this.#ui.appendError(error));
        } else if (status.phase === "failed") {
            const failure = `${status.generation}:${status.error?.message ?? "unknown failure"}`;
            if (failure !== this.#lastFailure) {
                this.#lastFailure = failure;
                this.#ui.append(
                    `Live indexing failed for ${status.branch ?? "the worktree"}: ${status.error?.message ?? "unknown failure"}. Retrieval is paused until a successful retry.`,
                    "warning",
                );
            }
        }
        this.#ui.updateHeader();
    }

    #ensureProgress(status: ProjectLiveIndexingStatus): void {
        this.#progress.start({
            stage: "provider",
            message: status.phase === "pending"
                ? `Waiting for changes to settle · ${status.target ?? "live target"}`
                : `Preparing ${status.target ?? "live target"}`,
        });
        if (status.phase === "indexing" && this.#indexingProgress !== undefined) {
            this.#progress.setIndexing(this.#indexingProgress);
        }
    }

    #onIndexingEvent(event: ProjectIndexingEvent): void {
        const previous = this.#indexingProgress;
        if (event.type === "indexing-progress") this.#indexingProgress = event.progress;
        if (this.#terminalSuspended() || !this.#progress.active) return;
        if (event.type === "provider-diagnostic") {
            this.#progress.set({
                stage: "provider",
                message: event.state === "started" ? `Checking ${event.model}` : "Provider ready",
            });
        } else if (event.type === "indexing-progress") {
            this.#progress.setIndexing(event.progress);
            this.#progress.requestRender(
                shouldRenderIndexingProgressImmediately(previous, event.progress),
            );
            return;
        } else if (event.type === "target-publication") {
            this.#progress.set({ stage: "provider", message: `Publishing ${event.target}` });
        }
        this.#progress.requestRender();
    }

    async #acceptReady(status: ProjectLiveIndexingStatus): Promise<void> {
        const configuration = this.#liveConfiguration;
        const publication = status.target === undefined || status.indexBuildId === undefined
            ? undefined
            : `${status.target}:${status.indexBuildId}`;
        if (
            configuration === undefined ||
            status.indexBuildId === undefined ||
            status.target === undefined ||
            publication === this.#lastReadyPublication
        ) return;
        const readyIdentity: LiveReadyIdentity = {
            branch: status.branch,
            target: status.target,
        };
        const recoveredFromFailure = this.#lastFailure !== undefined;
        const announce = shouldAnnounceLiveReady(
            this.#lastReadyIdentity,
            readyIdentity,
            recoveredFromFailure,
        );
        this.#lastFailure = undefined;
        await this.#preferences.set({
            projectIdentifier: configuration.projectIdentifier,
            root: configuration.root,
            profile: configuration.profile,
            preset: configuration.preset,
            target: status.target,
            keepReplacedBuilds: configuration.keepReplacedBuilds,
            allowDirty: true,
        });
        this.#lastReadyPublication = publication;
        this.#lastReadyIdentity = readyIdentity;
        await this.#refreshProjects(configuration.projectIdentifier);
        if (announce) {
            this.#ui.append(
                `✓ Live index ${recoveredFromFailure ? "recovered" : "ready"} for ${status.branch ?? "the worktree"} · ${status.target} · build ${status.indexBuildId.slice(0, 12)}…`,
                "success",
            );
        }
    }
}

function relativeTime(value?: string): string {
    if (!value) return "unknown time";
    const milliseconds = Date.now() - new Date(value).getTime();
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
