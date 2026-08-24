import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import {
    CombinedAutocompleteProvider,
    Container,
    Editor,
    Key,
    matchesKey,
    ProcessTerminal,
    Spacer,
    Text,
    TuiMainScreen,
    type AutocompleteItem,
    type SelectItem,
    type SlashCommand,
} from "@earendil-works/pi-tui";
import {
    CollectionService,
    deleteIndexedProject,
    IndexingPresetService,
    listIndexedProjects,
    managedProjectIdentifier,
    normalizeRetrievalTargetName,
    ProjectIndexingService,
    ProjectInspectionService,
    ProjectLiveIndexingService,
    ProjectRetrievalTargetService,
    ProviderProfileRenameService,
    ProjectSearchService,
    ProviderProfileService,
    SqliteStorageProvider,
    type IndexedProjectSummary,
    type IndexingProgress,
    type IndexingPreset,
    type IndexingPresetInput,
    type CollectionService as CollectionServiceType,
    type CollectionSummary,
    type OpenAiCompatibleModelSummary,
    type ProjectIndexingEvent,
    type ProjectLiveIndexingEvent,
    type ProjectLiveIndexingStatus,
    type ProviderProfile,
    type ProviderProfileInput,
    type RetrievalResult,
} from "scribery";

import { commandHelp, COMMANDS } from "./commands.js";
import { FooterComponent } from "./components/footer.js";
import { HeaderComponent } from "./components/header.js";
import { IndexingProgressComponent } from "./components/indexing-progress.js";
import { Picker } from "./components/picker.js";
import { PromptLabelComponent } from "./components/prompt-label.js";
import { SearchResultsComponent } from "./components/search-results.js";
import { TextPrompt } from "./components/text-prompt.js";
import type { ProjectPreference } from "./domain/project-preferences.js";
import { ProjectPreferenceStore } from "./services/preference-store.js";
import { formatError } from "./services/error-formatter.js";
import { shouldRenderIndexingProgressImmediately } from "./services/indexing-render-policy.js";
import { editJsonConfiguration } from "./services/json-config-editor.js";
import {
    SystemProfileCredentialStore,
    type ProfileCredentialStore,
} from "./services/profile-credential-store.js";
import { projectForDirectory } from "./services/project-context.js";
import { colors, editorTheme } from "./theme.js";

interface ActiveJob {
    root: string;
    controller: AbortController;
    startedAt: number;
    progress?: IndexingProgress;
}

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

interface ProposedLiveConfiguration {
    projectIdentifier: string;
    root: string;
    profile: string;
    preset: string;
    keepReplacedBuilds: number;
    presetValue: IndexingPreset;
}

export interface ScriberyTuiAppOptions {
    cwd?: string;
    preferences?: ProjectPreferenceStore;
    credentials?: ProfileCredentialStore;
}

export class ScriberyTuiApp {
    readonly #cwd: string;
    readonly #preferences: ProjectPreferenceStore;
    readonly #credentials: ProfileCredentialStore;
    readonly #environmentApiKey = environmentApiKey();
    readonly #sessionApiKeys = new Map<string, string>();
    readonly #storedApiKeyCache = new Map<string, string | null>();
    readonly #profiles = new ProviderProfileService(apiKeyOptions(this.#environmentApiKey));
    readonly #profileRenames = new ProviderProfileRenameService();
    readonly #presets = new IndexingPresetService();
    readonly #indexing = new ProjectIndexingService(apiKeyOptions(this.#environmentApiKey));
    readonly #inspection = new ProjectInspectionService();
    readonly #targets = new ProjectRetrievalTargetService();
    readonly #ui = new TuiMainScreen(new ProcessTerminal());
    readonly #header = new HeaderComponent();
    readonly #transcript = new Container();
    readonly #progressArea = new Container();
    readonly #editorArea = new Container();
    readonly #promptLabel = new PromptLabelComponent();
    readonly #editor = new Editor(this.#ui, editorTheme, {
        paddingX: 1,
        autocompleteMaxVisible: 10,
    });
    readonly #footer = new FooterComponent();
    #projects: readonly IndexedProjectSummary[] = [];
    #activeProject: IndexedProjectSummary | undefined;
    #activePreference: ProjectPreference | undefined;
    #activeJob: ActiveJob | undefined;
    #live: ProjectLiveIndexingService | undefined;
    #liveStatus: ProjectLiveIndexingStatus | undefined;
    #liveConfiguration: ProposedLiveConfiguration | undefined;
    #liveProgress: IndexingProgress | undefined;
    #lastLiveReadyPublication: string | undefined;
    #lastLiveFailure: string | undefined;
    #livePublicationChain: Promise<void> = Promise.resolve();
    #progress: IndexingProgressComponent | undefined;
    #progressTimer: NodeJS.Timeout | undefined;
    #lastInterrupt = 0;
    #stopping = false;
    #modalActive = false;
    #cancelPromptActive = false;
    #terminalSuspended = false;
    #credentialAvailability: Promise<boolean> | undefined;
    #resolveRun?: () => void;

    constructor(options: ScriberyTuiAppOptions = {}) {
        this.#cwd = resolve(options.cwd ?? process.cwd());
        this.#preferences = options.preferences ?? new ProjectPreferenceStore();
        this.#credentials = options.credentials ?? new SystemProfileCredentialStore();
        this.#footer.setLocation(this.#cwd);
        this.#editor.setAutocompleteProvider(
            new CombinedAutocompleteProvider(this.#autocompleteCommands(), this.#cwd),
        );
        this.#editor.onSubmit = (text) => {
            void this.#submit(text);
        };
        this.#editorArea.addChild(this.#promptLabel);
        this.#editorArea.addChild(this.#editor);
        this.#editorArea.addChild(this.#footer);
        this.#ui.addChild(this.#header);
        this.#ui.addChild(new Spacer(1));
        this.#ui.addChild(this.#transcript);
        this.#ui.addChild(this.#progressArea);
        this.#ui.addChild(this.#editorArea);
        this.#ui.addInputListener((data) => this.#handleGlobalInput(data));
    }

    async run(): Promise<void> {
        await this.#refreshProjects();
        this.#append(
            this.#activeProject
                ? `Ready in ${basename(this.#activeProject.root ?? this.#activeProject.projectIdentifier)}. Type a question to search or / for commands.`
                : "No indexed project was found here. Use /index to create one or /project to choose an existing project.",
            "muted",
        );
        this.#ui.terminal.setTitle("Scribery");
        this.#ui.setFocus(this.#editor);
        this.#ui.start();
        return new Promise<void>((resolveRun) => {
            this.#resolveRun = resolveRun;
        });
    }

    async #submit(raw: string): Promise<void> {
        const text = raw.trim();
        if (!text) return;
        this.#editor.addToHistory(text);
        this.#editor.setText("");
        if (!text.startsWith("/")) {
            await this.#runSearch(text);
            return;
        }
        const [name = "", ...arguments_] = text.slice(1).split(/\s+/u);
        const argument = arguments_.join(" ").trim();
        try {
            await this.#runCommand(name.toLowerCase(), argument);
        } catch (error: unknown) {
            this.#appendError(error);
        }
    }

    async #runCommand(name: string, argument: string): Promise<void> {
        switch (name) {
            case "index": await this.#configureAndIndex(); break;
            case "live": await this.#manageLive(argument); break;
            case "project": await this.#selectProject(argument); break;
            case "search": await this.#promptSearch(); break;
            case "profile": await this.#manageProfiles(argument); break;
            case "preset": await this.#managePresets(argument); break;
            case "builds": await this.#browseBuilds(); break;
            case "target": await this.#manageTargets(); break;
            case "chunks": await this.#inspectChunks(argument); break;
            case "collection": await this.#manageCollections(); break;
            case "jobs": this.#showJobs(); break;
            case "mcp": await this.#showMcp(); break;
            case "doctor": await this.#doctor(); break;
            case "settings": await this.#showSettings(); break;
            case "help": this.#append(commandHelp()); break;
            case "clear": this.#transcript.clear(); this.#ui.requestRender(true); break;
            case "quit": await this.#quit(); break;
            default: this.#append(`Unknown command /${name}. Type /help to see available commands.`, "warning");
        }
    }

    async #runSearch(query: string): Promise<void> {
        if (!this.#activeProject) {
            this.#append("Choose an indexed project with /project, or create one with /index.", "warning");
            return;
        }
        const profile = await this.#searchProfile();
        if (!profile) {
            this.#append("This project has no provider profile. Use /profile to select one.", "warning");
            return;
        }
        this.#promptLabel.setState(this.#activeProject.root, true);
        this.#ui.requestRender();
        try {
            const searchService = await this.#searchService(profile);
            const response = await searchService.search({
                query,
                projectReference: this.#activeProject.projectIdentifier,
                profile,
                limit: 10,
                context: { beforeChunks: 1, afterChunks: 1, maximumCharacters: 12_000 },
                reranking: { enabled: true, failureMode: "use-semantic-order" },
            }, this.#cwd);
            const component = new SearchResultsComponent({
                query,
                results: response.results,
                requestRender: () => this.#ui.requestRender(),
                onDone: () => this.#ui.setFocus(this.#editor),
                onOpen: (result) => { void this.#openSearchResult(result); },
            });
            this.#transcript.addChild(component);
            this.#transcript.addChild(new Spacer(1));
            if (response.results.length > 0) this.#ui.setFocus(component);
        } finally {
            this.#promptLabel.setState(this.#activeProject.root, false);
            this.#ui.requestRender();
        }
    }

    async #promptSearch(): Promise<void> {
        const query = await this.#input("Search the active project", "Query");
        if (query?.trim()) await this.#runSearch(query.trim());
    }

    async #configureAndIndex(): Promise<void> {
        if (this.#live?.running) {
            this.#append("Stop live indexing with /live stop before running a manual index.", "warning");
            return;
        }
        if (this.#activeJob) {
            this.#append(`An index is already running for ${basename(this.#activeJob.root)}.`, "warning");
            return;
        }
        const root = this.#activeProject?.root ?? detectProjectRoot(this.#cwd);
        const profiles = await this.#profiles.list();
        const presets = await this.#presets.list();
        if (profiles.length === 0) {
            this.#append("Create a provider profile with /profile before indexing.", "warning");
            return;
        }
        if (presets.length === 0) {
            this.#append("Create an indexing preset with /preset before indexing.", "warning");
            return;
        }

        let profileName = this.#activePreference?.profile;
        let presetName = this.#activePreference?.preset;
        if (!profiles.some(({ name }) => name === profileName)) profileName = undefined;
        if (!presets.some(({ name }) => name === presetName)) presetName = undefined;
        if (!profileName) profileName = await this.#pickProfile(profiles, "Select provider profile") ?? undefined;
        if (!profileName) return;
        if (!presetName) presetName = await this.#pickPreset(presets, "Select indexing preset") ?? undefined;
        if (!presetName) return;

        let target = this.#activePreference?.target ?? "main";
        while (true) {
            const action = await this.#pick("Index project", [
                { value: "start", label: "Start indexing", description: `${profileName} · ${presetName} · target ${target}` },
                { value: "profile", label: "Change profile", description: profileName },
                { value: "preset", label: "Change preset", description: presetName },
                { value: "target", label: "Change target", description: target },
                { value: "cancel", label: "Cancel" },
            ]);
            if (!action || action.value === "cancel") return;
            if (action.value === "start") break;
            if (action.value === "profile") {
                const selected = await this.#pickProfile(profiles, "Select provider profile");
                if (selected) profileName = selected;
            } else if (action.value === "preset") {
                const selected = await this.#pickPreset(presets, "Select indexing preset");
                if (selected) presetName = selected;
            } else if (action.value === "target") {
                const selected = (await this.#input(
                    "Index project",
                    "Target",
                    target,
                ))?.trim();
                if (selected) target = normalizeRetrievalTargetName(selected);
            }
        }

        const presetValue = presets.find(({ name }) => name === presetName)!;
        const configuration: ProposedIndexConfiguration = {
            projectIdentifier: this.#activeProject?.projectIdentifier ?? managedProjectIdentifier(root),
            root,
            profile: profileName,
            preset: presetName,
            target,
            keepReplacedBuilds: this.#activePreference?.keepReplacedBuilds ?? 1,
            allowDirty: this.#activePreference?.allowDirty ?? false,
            presetValue,
        };
        void this.#startIndex(configuration);
    }

    async #startIndex(configuration: ProposedIndexConfiguration): Promise<void> {
        const controller = new AbortController();
        this.#activeJob = { root: configuration.root, controller, startedAt: Date.now() };
        this.#progress = new IndexingProgressComponent();
        this.#progress.setState({ stage: "provider", message: `Checking profile ${configuration.profile}` });
        this.#progressArea.addChild(this.#progress);
        this.#progressTimer = setInterval(() => {
            this.#progress?.tick();
            this.#ui.requestRender();
        }, 90);
        this.#updateHeader();
        this.#ui.terminal.setProgress(true);
        this.#ui.requestRender();

        try {
            const indexingService = await this.#indexingService(configuration.profile);
            const outcome = await indexingService.index({
                root: configuration.root,
                provider: { type: "profile", profile: configuration.profile },
                target: configuration.target,
                keepReplacedBuilds: configuration.keepReplacedBuilds ?? 1,
                ...(configuration.allowDirty ? { allowDirty: true } : {}),
                ...(configuration.presetValue.maximumChunkSize === undefined
                    ? {}
                    : { maximumChunkSize: configuration.presetValue.maximumChunkSize }),
                ...(configuration.presetValue.windows1251 === undefined
                    ? {}
                    : { windows1251: configuration.presetValue.windows1251 }),
                ...(configuration.presetValue.include === undefined
                    ? {}
                    : { include: configuration.presetValue.include }),
                ...(configuration.presetValue.exclude === undefined
                    ? {}
                    : { exclude: configuration.presetValue.exclude }),
                signal: controller.signal,
                onEvent: (event) => this.#onIndexEvent(event),
            });
            await this.#preferences.set({
                ...configuration,
                projectIdentifier: outcome.project?.projectIdentifier ?? configuration.projectIdentifier,
            });
            const elapsed = formatDuration(Date.now() - this.#activeJob.startedAt);
            this.#append(
                `✓ Indexed ${basename(configuration.root)} in ${elapsed}\n` +
                `  ${outcome.result.discoveredFiles.toLocaleString()} files · ` +
                `${outcome.result.indexedChunks.toLocaleString()} chunks · ` +
                `${outcome.result.reusedEmbeddings.toLocaleString()} embeddings reused · ` +
                `build ${outcome.result.indexBuildId.slice(0, 12)}…`,
                "success",
            );
        } catch (error: unknown) {
            if (controller.signal.aborted) {
                this.#append(`Indexing ${basename(configuration.root)} was cancelled.`, "warning");
            } else {
                this.#appendError(error);
            }
        } finally {
            this.#stopProgress();
            this.#activeJob = undefined;
            await this.#refreshProjects(configuration.projectIdentifier);
            this.#ui.terminal.setProgress(false);
            this.#ui.requestRender();
        }
    }

    #onIndexEvent(event: ProjectIndexingEvent): void {
        if (!this.#progress || !this.#activeJob) return;
        if (event.type === "provider-diagnostic") {
            this.#progress.setState({
                stage: "provider",
                message: event.state === "started"
                    ? `Checking ${event.model}`
                    : "Provider ready",
            });
        } else if (event.type === "indexing-progress") {
            const previousProgress = this.#activeJob.progress;
            this.#activeJob.progress = event.progress;
            this.#progress.setState({ stage: "indexing", progress: event.progress });
            if (shouldRenderIndexingProgressImmediately(previousProgress, event.progress)) {
                this.#ui.renderNow();
                return;
            }
        } else if (event.type === "target-publication") {
            this.#progress.setState({ stage: "provider", message: `Publishing target ${event.target}` });
        }
        this.#ui.requestRender();
    }

    #stopProgress(): void {
        if (this.#progressTimer) clearInterval(this.#progressTimer);
        this.#progressTimer = undefined;
        this.#progressArea.clear();
        this.#progress = undefined;
    }

    async #manageLive(argument = ""): Promise<void> {
        const requestedAction = argument.toLowerCase();
        if (requestedAction === "status") {
            this.#showLiveStatus();
            return;
        }
        if (requestedAction === "stop") {
            await this.#stopLive();
            return;
        }
        if (requestedAction === "reconcile") {
            this.#reconcileLive();
            return;
        }
        if (requestedAction && requestedAction !== "start") {
            throw new Error("Usage: /live [start|status|reconcile|stop]");
        }

        if (this.#live?.running) {
            const action = await this.#pick("Live indexing", [
                { value: "status", label: "Show status", description: this.#liveStatus?.phase ?? "starting" },
                { value: "reconcile", label: "Index now", description: "Reconcile without waiting for another file event" },
                { value: "stop", label: "Stop live indexing", description: "Keep the last published branch target" },
            ]);
            if (action?.value === "status") this.#showLiveStatus();
            else if (action?.value === "reconcile") this.#reconcileLive();
            else if (action?.value === "stop") await this.#stopLive();
            return;
        }
        if (requestedAction === "reconcile" || requestedAction === "stop") {
            this.#append("Live indexing is not running in this TUI.", "muted");
            return;
        }
        if (this.#activeJob) {
            this.#append("Wait for the current indexing operation to finish before starting live mode.", "warning");
            return;
        }
        const project = this.#activeProject;
        if (!project?.root) {
            this.#append("Create the first project index with /index before starting live mode.", "warning");
            return;
        }
        const profiles = await this.#profiles.list();
        const presets = await this.#presets.list();
        if (profiles.length === 0 || presets.length === 0) {
            this.#append("Live indexing needs an existing provider profile and indexing preset.", "warning");
            return;
        }
        let profileName = profiles.some(({ name }) => name === this.#activePreference?.profile)
            ? this.#activePreference!.profile
            : undefined;
        let presetName = presets.some(({ name }) => name === this.#activePreference?.preset)
            ? this.#activePreference!.preset
            : undefined;
        if (!profileName) profileName = await this.#pickProfile(profiles, "Select live indexing profile");
        if (!profileName) return;
        if (!presetName) presetName = await this.#pickPreset(presets, "Select live indexing preset");
        if (!presetName) return;

        while (true) {
            const action = await this.#pick("Start live indexing", [
                { value: "start", label: "Start live indexing", description: `${profileName} · ${presetName}` },
                { value: "profile", label: "Change profile", description: profileName },
                { value: "preset", label: "Change preset", description: presetName },
                { value: "cancel", label: "Cancel" },
            ]);
            if (!action || action.value === "cancel") return;
            if (action.value === "start") break;
            if (action.value === "profile") {
                profileName = await this.#pickProfile(profiles, "Select live indexing profile", profileName) ?? profileName;
            } else if (action.value === "preset") {
                presetName = await this.#pickPreset(presets, "Select live indexing preset") ?? presetName;
            }
        }

        const configuration: ProposedLiveConfiguration = {
            projectIdentifier: project.projectIdentifier,
            root: project.root,
            profile: profileName,
            preset: presetName,
            keepReplacedBuilds: this.#activePreference?.keepReplacedBuilds ?? 1,
            presetValue: presets.find(({ name }) => name === presetName)!,
        };
        void this.#startLive(configuration);
    }

    async #startLive(configuration: ProposedLiveConfiguration): Promise<void> {
        const service = new ProjectLiveIndexingService(
            apiKeyOptions(await this.#apiKey(configuration.profile)),
        );
        this.#live = service;
        this.#liveConfiguration = configuration;
        this.#liveStatus = undefined;
        this.#liveProgress = undefined;
        this.#lastLiveReadyPublication = undefined;
        this.#lastLiveFailure = undefined;
        this.#append(
            `Starting live indexing for ${basename(configuration.root)}. The current Git branch will publish to live/<branch>.`,
            "muted",
        );
        this.#updateHeader();
        try {
            await service.start({
                root: configuration.root,
                projectReference: configuration.projectIdentifier,
                provider: { type: "profile", profile: configuration.profile },
                keepReplacedBuilds: configuration.keepReplacedBuilds,
                ...(configuration.presetValue.maximumChunkSize === undefined
                    ? {}
                    : { maximumChunkSize: configuration.presetValue.maximumChunkSize }),
                ...(configuration.presetValue.windows1251 === undefined
                    ? {}
                    : { windows1251: configuration.presetValue.windows1251 }),
                ...(configuration.presetValue.include === undefined
                    ? {}
                    : { include: configuration.presetValue.include }),
                ...(configuration.presetValue.exclude === undefined
                    ? {}
                    : { exclude: configuration.presetValue.exclude }),
                onEvent: (event) => this.#onLiveEvent(event),
            });
        } catch (error: unknown) {
            if (this.#live === service) {
                await service.stop().catch(() => {});
                this.#live = undefined;
                this.#liveConfiguration = undefined;
                this.#stopProgress();
                this.#ui.terminal.setProgress(false);
                this.#updateHeader();
            }
            this.#appendError(error);
        }
    }

    #onLiveEvent(event: ProjectLiveIndexingEvent): void {
        if (event.type === "indexing") {
            this.#onLiveIndexEvent(event.event);
            return;
        }
        const status = event.status;
        this.#liveStatus = status;
        if (status.phase === "pending") this.#liveProgress = undefined;
        if (!this.#terminalSuspended) {
            if (status.phase === "pending" || status.phase === "indexing" || status.phase === "starting") {
                this.#ensureLiveProgress(status);
            } else {
                this.#stopProgress();
                this.#ui.terminal.setProgress(false);
            }
        }
        if (status.phase === "ready" && status.indexBuildId !== undefined) {
            this.#livePublicationChain = this.#livePublicationChain
                .catch(() => {})
                .then(() => this.#acceptLiveReady(status))
                .catch((error: unknown) => this.#appendError(error));
        } else if (status.phase === "failed") {
            const failure = `${status.generation}:${status.error?.message ?? "unknown failure"}`;
            if (failure !== this.#lastLiveFailure) {
                this.#lastLiveFailure = failure;
                this.#append(
                    `Live indexing failed for ${status.branch ?? "the worktree"}: ${status.error?.message ?? "unknown failure"}. Retrieval is paused until a successful retry.`,
                    "warning",
                );
            }
        }
        this.#updateHeader();
    }

    #ensureLiveProgress(status: ProjectLiveIndexingStatus): void {
        if (!this.#progress) {
            this.#progress = new IndexingProgressComponent();
            this.#progressArea.addChild(this.#progress);
            this.#progressTimer = setInterval(() => {
                this.#progress?.tick();
                if (!this.#terminalSuspended) this.#ui.requestRender();
            }, 90);
        }
        this.#progress.setState({
            stage: "provider",
            message: status.phase === "pending"
                ? `Waiting for changes to settle · ${status.target ?? "live target"}`
                : `Preparing ${status.target ?? "live target"}`,
        });
        if (status.phase === "indexing" && this.#liveProgress !== undefined) {
            this.#progress.setState({ stage: "indexing", progress: this.#liveProgress });
        }
        this.#ui.terminal.setProgress(true);
        this.#ui.requestRender();
    }

    #onLiveIndexEvent(event: ProjectIndexingEvent): void {
        const previous = this.#liveProgress;
        if (event.type === "indexing-progress") this.#liveProgress = event.progress;
        if (this.#terminalSuspended || !this.#progress) return;
        if (event.type === "provider-diagnostic") {
            this.#progress.setState({
                stage: "provider",
                message: event.state === "started" ? `Checking ${event.model}` : "Provider ready",
            });
        } else if (event.type === "indexing-progress") {
            this.#progress.setState({ stage: "indexing", progress: event.progress });
            if (shouldRenderIndexingProgressImmediately(previous, event.progress)) {
                this.#ui.renderNow();
                return;
            }
        } else if (event.type === "target-publication") {
            this.#progress.setState({ stage: "provider", message: `Publishing ${event.target}` });
        }
        this.#ui.requestRender();
    }

    async #acceptLiveReady(status: ProjectLiveIndexingStatus): Promise<void> {
        const configuration = this.#liveConfiguration;
        const publication = status.target === undefined || status.indexBuildId === undefined
            ? undefined
            : `${status.target}:${status.indexBuildId}`;
        if (
            configuration === undefined ||
            status.indexBuildId === undefined ||
            status.target === undefined ||
            publication === this.#lastLiveReadyPublication
        ) return;
        this.#lastLiveFailure = undefined;
        await this.#preferences.set({
            projectIdentifier: configuration.projectIdentifier,
            root: configuration.root,
            profile: configuration.profile,
            preset: configuration.preset,
            target: status.target,
            keepReplacedBuilds: configuration.keepReplacedBuilds,
            allowDirty: true,
        });
        this.#lastLiveReadyPublication = publication;
        await this.#refreshProjects(configuration.projectIdentifier);
        this.#append(
            `✓ Live index ready for ${status.branch ?? "the worktree"} · ${status.target ?? "live target"} · build ${status.indexBuildId.slice(0, 12)}…`,
            "success",
        );
    }

    #reconcileLive(): void {
        const service = this.#live;
        if (!service?.running) {
            this.#append("Live indexing is not running in this TUI.", "muted");
            return;
        }
        this.#append("Live reconciliation requested.", "muted");
        void service.reconcile().catch((error: unknown) => this.#appendError(error));
    }

    async #stopLive(): Promise<void> {
        const service = this.#live;
        if (!service?.running) {
            this.#append("Live indexing is not running in this TUI.", "muted");
            return;
        }
        await service.stop();
        await this.#livePublicationChain;
        if (this.#live === service) {
            this.#live = undefined;
            this.#liveConfiguration = undefined;
            this.#liveProgress = undefined;
        }
        this.#stopProgress();
        this.#ui.terminal.setProgress(false);
        this.#updateHeader();
        this.#append("Live indexing stopped. The last ready branch target remains available.", "success");
    }

    #showLiveStatus(): void {
        const status = this.#liveStatus;
        if (status === undefined || status.phase === "stopped") {
            this.#append("Live indexing is not running in this TUI.", "muted");
            return;
        }
        this.#append([
            `Live indexing ${status.phase}`,
            `Project: ${status.root}`,
            `Branch: ${status.branch ?? "unknown"}`,
            `Target: ${status.target ?? "pending"}`,
            `Build: ${status.indexBuildId?.slice(0, 12) ?? "pending"}`,
            `Updated: ${relativeTime(status.updatedAt)}`,
        ].join("\n"));
    }

    async #selectProject(argument = ""): Promise<void> {
        if (this.#live?.running && argument !== "info") {
            this.#append("Stop live indexing with /live stop before switching or forgetting projects.", "warning");
            return;
        }
        await this.#refreshProjects();
        if (argument === "info") {
            const project = this.#requiredProject();
            this.#append(JSON.stringify({
                ...project,
                preference: this.#activePreference ?? null,
            }, null, 2));
            return;
        }
        if (argument === "forget") {
            const project = this.#requiredProject();
            const name = basename(project.root ?? project.projectIdentifier);
            if (!await this.#confirm(`Forget ${name}? Source files will not be touched.`, false)) return;
            await deleteIndexedProject(project.projectIdentifier);
            await this.#preferences.remove(project.projectIdentifier);
            this.#activeProject = undefined;
            this.#activePreference = undefined;
            await this.#refreshProjects();
            this.#append(`Removed the managed index for ${name}.`, "success");
            return;
        }
        if (this.#projects.length === 0) {
            this.#append("No indexed projects are available. Run /index in a project first.", "warning");
            return;
        }
        const direct = argument
            ? this.#projects.find((project) =>
                project.projectIdentifier === argument ||
                project.root === resolve(argument) ||
                basename(project.root ?? project.projectIdentifier) === argument
            )
            : undefined;
        const selected = direct ? {
            value: direct.projectIdentifier,
            label: basename(direct.root ?? direct.projectIdentifier),
        } : await this.#pick("Select project", this.#projects.map((project) => ({
            value: project.projectIdentifier,
            label: basename(project.root ?? project.projectIdentifier),
            description: project.latestReadyBuild
                ? `${project.latestReadyBuild.model} · ${relativeTime(project.latestReadyBuild.completedAt)}`
                : `${project.buildCount} builds · no ready build`,
        })));
        if (!selected) return;
        await this.#refreshProjects(selected.value);
        this.#append(`Switched to ${basename(this.#activeProject?.root ?? selected.value)}.`, "success");
    }

    #autocompleteCommands(): SlashCommand[] {
        return COMMANDS.map((command) => {
            if (command.name === "project") {
                return {
                    ...command,
                    argumentHint: "[project|info|forget]",
                    getArgumentCompletions: (prefix: string) => [
                        { value: "info", label: "info", description: "Show active project details" },
                        { value: "forget", label: "forget", description: "Remove the managed index" },
                        ...this.#projects.map((project) => ({
                            value: project.projectIdentifier,
                            label: basename(project.root ?? project.projectIdentifier),
                            ...(project.root === undefined ? {} : { description: project.root }),
                        })),
                    ].filter((item) => `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(prefix.toLowerCase())),
                };
            }
            if (command.name === "live") {
                return {
                    ...command,
                    argumentHint: "[start|status|reconcile|stop]",
                    getArgumentCompletions: (prefix: string) => [
                        { value: "start", label: "start", description: "Start branch-aware live indexing" },
                        { value: "status", label: "status", description: "Show the current live state" },
                        { value: "reconcile", label: "reconcile", description: "Index the worktree now" },
                        { value: "stop", label: "stop", description: "Stop and preserve the last live target" },
                    ].filter((item) => item.value.includes(prefix.toLowerCase())),
                };
            }
            if (command.name === "profile") {
                return {
                    ...command,
                    argumentHint: "[profile]",
                    getArgumentCompletions: async (prefix: string) => (await this.#profiles.list())
                        .filter((profile) => `${profile.name} ${profile.embedding.model}`.toLowerCase().includes(prefix.toLowerCase()))
                        .map((profile) => ({
                            value: profile.name,
                            label: profile.name,
                            description: profile.embedding.model,
                        })),
                };
            }
            if (command.name === "preset") {
                return {
                    ...command,
                    argumentHint: "[preset]",
                    getArgumentCompletions: async (prefix: string) => (await this.#presets.list())
                        .filter((preset) => preset.name.toLowerCase().includes(prefix.toLowerCase()))
                        .map((preset) => ({
                            value: preset.name,
                            label: preset.name,
                            description: `${preset.maximumChunkSize ?? "default"} chars`,
                        })),
                };
            }
            if (command.name === "chunks") {
                return {
                    ...command,
                    getArgumentCompletions: (prefix: string) => this.#fileCompletions(prefix),
                };
            }
            return { ...command };
        });
    }

    async #fileCompletions(prefix: string): Promise<AutocompleteItem[]> {
        const root = this.#activeProject?.root;
        if (!root) return [];
        try {
            const entries = await readdir(root, { recursive: true });
            const normalizedPrefix = prefix.toLowerCase();
            return entries
                .filter((entry) =>
                    !entry.startsWith(".git/") &&
                    !entry.includes("/node_modules/") &&
                    !entry.startsWith("node_modules/") &&
                    entry.toLowerCase().includes(normalizedPrefix)
                )
                .slice(0, 300)
                .map((entry) => ({ value: entry, label: entry }));
        } catch {
            return [];
        }
    }

    async #manageProfiles(argument = ""): Promise<void> {
        if (this.#live?.running) {
            this.#append("Stop live indexing before changing provider profiles.", "warning");
            return;
        }
        const profiles = await this.#profiles.list();
        const direct = argument ? profiles.find(({ name }) => name === argument) : undefined;
        const profileItems = await Promise.all(profiles.map(async (profile) => ({
            value: profile.name,
            label: profile.name,
            description: `${profile.embedding.model} · ${profile.embedding.dimensions} dimensions · ${this.#rerankingSummary(profile)} · API key ${await this.#apiKeySource(profile.name)}`,
        })));
        const selection = direct ? { value: direct.name, label: direct.name } : await this.#pick("Provider profiles", [
            { value: "__create", label: "+ Create profile", description: "Discover an OpenAI-compatible model" },
            ...profileItems,
        ]);
        if (!selection) return;
        if (selection.value === "__create") {
            await this.#createProfile();
            return;
        }
        const profile = profiles.find(({ name }) => name === selection.value)!;
        const hasSessionApiKey = this.#sessionApiKeys.has(profile.name);
        const credentialsAvailable = await this.#credentialsAvailable();
        const storedApiKey = credentialsAvailable
            ? await this.#storedApiKey(profile.name)
            : undefined;
        const action = await this.#pick(profile.name, [
            { value: "use", label: "Use for current project" },
            ...(credentialsAvailable
                ? [{
                    value: "save-api-key",
                    label: storedApiKey === undefined
                        ? `Save API key in ${this.#credentials.displayName}`
                        : `Replace API key in ${this.#credentials.displayName}`,
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
                : [{ value: "forget-api-key", label: `Forget API key in ${this.#credentials.displayName}` }]),
            ...(!credentialsAvailable
                ? [{ value: "keyring-unavailable", label: `${this.#credentials.displayName} unavailable`, description: "Session and environment keys still work" }]
                : []),
            { value: "test", label: "Test connection" },
            { value: "edit", label: "Edit profile" },
            {
                value: "edit-json",
                label: "Edit JSON",
                description: "Open validated profile JSON in a terminal editor",
            },
            { value: "rename", label: "Rename" },
            { value: "show", label: "Show configuration" },
            { value: "delete", label: "Delete profile" },
        ]);
        if (!action) return;
        if (action.value === "use") {
            if (!this.#activeProject || !this.#activePreference) {
                this.#append("Select a preset during /index before changing an existing project profile.", "warning");
                return;
            }
            this.#activePreference = await this.#preferences.set({ ...this.#activePreference, profile: profile.name });
            this.#append(`Project profile changed to ${profile.name}.`, "success");
            this.#updateHeader();
        } else if (action.value === "save-api-key") {
            const apiKey = await this.#secretInput(`API key for ${profile.name}`, "API key");
            if (apiKey === undefined) return;
            if (apiKey.length === 0) {
                this.#append("The API key was empty; nothing changed.", "warning");
                return;
            }
            await this.#credentials.set(profile.name, apiKey);
            this.#storedApiKeyCache.set(profile.name, apiKey);
            this.#sessionApiKeys.delete(profile.name);
            this.#append(`Saved the API key for ${profile.name} in ${this.#credentials.displayName}.`, "success");
            await this.#diagnoseProfile(profile.name);
        } else if (action.value === "session-api-key") {
            const apiKey = await this.#secretInput(`API key for ${profile.name}`, "API key");
            if (apiKey === undefined) return;
            if (apiKey.length === 0) {
                this.#append("The API key was empty; nothing changed.", "warning");
                return;
            }
            this.#sessionApiKeys.set(profile.name, apiKey);
            this.#append(`API key set for ${profile.name}. It will be forgotten when this TUI exits.`, "success");
        } else if (action.value === "clear-session-api-key") {
            this.#sessionApiKeys.delete(profile.name);
            this.#append(`Cleared the session API key for ${profile.name}; API key ${await this.#apiKeySource(profile.name)} is active.`, "success");
        } else if (action.value === "forget-api-key") {
            if (!await this.#confirm(`Forget the saved API key for ${profile.name}?`)) return;
            if (!await this.#credentials.delete(profile.name)) {
                throw new Error(`Could not remove the saved API key for profile ${profile.name}`);
            }
            this.#storedApiKeyCache.set(profile.name, null);
            this.#append(`Forgot the saved API key for ${profile.name}; API key ${await this.#apiKeySource(profile.name)} is active.`, "success");
        } else if (action.value === "keyring-unavailable") {
            this.#append(`${this.#credentials.displayName} is unavailable. Use a session key or OPENAI_COMPATIBLE_API_KEY.`, "warning");
        } else if (action.value === "test") {
            await this.#diagnoseProfile(profile.name);
        } else if (action.value === "edit") {
            await this.#editProfile(profile);
        } else if (action.value === "edit-json") {
            await this.#editProfileJson(profile);
        } else if (action.value === "rename") {
            await this.#renameProfile(profile);
        } else if (action.value === "show") {
            this.#append(JSON.stringify(profile, null, 2));
        } else if (action.value === "delete") {
            const used = (await this.#preferences.list()).filter(({ profile: value }) => value === profile.name);
            if (used.length > 0) {
                this.#append(`Profile ${profile.name} is used by ${used.length} project(s) and cannot be deleted.`, "warning");
                return;
            }
            if (await this.#confirm(`Delete profile ${profile.name}?`)) {
                const savedApiKey = await this.#storedApiKey(profile.name);
                if (savedApiKey !== undefined && !await this.#credentials.delete(profile.name)) {
                    throw new Error(`Could not remove the saved API key for profile ${profile.name}`);
                }
                try {
                    await this.#profiles.remove(profile.name);
                } catch (error: unknown) {
                    if (savedApiKey !== undefined) {
                        try {
                            await this.#credentials.set(profile.name, savedApiKey);
                        } catch (rollbackError: unknown) {
                            throw new AggregateError(
                                [error, rollbackError],
                                "The profile could not be deleted and its saved API key could not be restored",
                            );
                        }
                    }
                    throw error;
                }
                this.#storedApiKeyCache.delete(profile.name);
                this.#sessionApiKeys.delete(profile.name);
                this.#append(`Deleted profile ${profile.name}.`, "success");
            }
        }
    }

    async #createProfile(): Promise<void> {
        const name = (await this.#input("Create provider profile", "Name"))?.trim();
        if (!name) return;
        const apiKey = await this.#secretInput("Create provider profile", "API key (optional)");
        if (apiKey === undefined) return;
        let apiKeyStorage: "saved" | "session" | undefined;
        if (apiKey) {
            if (await this.#credentialsAvailable()) {
                const storage = await this.#pick("API key storage", [
                    {
                        value: "saved",
                        label: `Save in ${this.#credentials.displayName}`,
                        description: "Recommended · available automatically on future launches",
                    },
                    {
                        value: "session",
                        label: "Use for this session",
                        description: "Kept only in memory and forgotten on exit",
                    },
                ]);
                if (!storage) return;
                apiKeyStorage = storage.value === "saved" ? "saved" : "session";
            } else {
                apiKeyStorage = "session";
            }
        }
        const profileService = new ProviderProfileService(apiKeyOptions(apiKey || this.#environmentApiKey));
        const configuration = await this.#promptProfileConfiguration(
            "Create provider profile",
            name,
            profileService,
        );
        if (configuration === undefined) return;
        const saved = await this.#profiles.set(configuration);
        if (apiKey && apiKeyStorage === "saved") {
            try {
                await this.#credentials.set(saved.name, apiKey);
                this.#storedApiKeyCache.set(saved.name, apiKey);
            } catch (error: unknown) {
                apiKeyStorage = "session";
                this.#sessionApiKeys.set(saved.name, apiKey);
                this.#append(
                    `Could not save the API key in ${this.#credentials.displayName}; using it for this session instead. ${formatError(error)}`,
                    "warning",
                );
            }
        } else if (apiKey) {
            this.#sessionApiKeys.set(saved.name, apiKey);
        }
        this.#append(
            `Created profile ${saved.name} with ${saved.embedding.dimensions} dimensions.`,
            "success",
        );
        if (apiKey && apiKeyStorage === "session" && !await this.#credentialsAvailable()) {
            this.#append(`${this.#credentials.displayName} is unavailable; the API key will be forgotten when this TUI exits.`, "warning");
        }
    }

    async #editProfile(profile: ProviderProfile): Promise<void> {
        const profileService = await this.#profileService(profile.name);
        const configuration = await this.#promptProfileConfiguration(
            `Edit ${profile.name}`,
            profile.name,
            profileService,
            profile,
        );
        if (configuration === undefined) return;
        await this.#profiles.set(configuration);
        this.#append(`Updated profile ${profile.name}.`, "success");
    }

    async #editProfileJson(profile: ProviderProfile): Promise<void> {
        const edited = await this.#editConfigurationJson(
            editableProfile(profile),
            `profile-${profile.name}`,
        );
        if (edited === undefined) {
            this.#append(`Profile ${profile.name} was not changed.`, "muted");
            return;
        }
        const input = requireEditedProfile(
            edited,
            profile.name,
        );
        await this.#profiles.set(input);
        this.#append(`Updated profile ${profile.name} from JSON.`, "success");
    }

    async #promptProfileConfiguration(
        title: string,
        name: string,
        profileService: ProviderProfileService,
        current?: ProviderProfile,
    ): Promise<ProviderProfileInput | undefined> {
        const baseUrlInput = await this.#input(
            title,
            "OpenAI-compatible base URL",
            current?.embedding.baseUrl ?? "http://127.0.0.1:1234/v1",
        );
        if (baseUrlInput === undefined) return undefined;
        const baseUrl = baseUrlInput.trim();
        const models = await this.#discoverProviderModels(
            profileService,
            baseUrl || undefined,
            current,
        );
        const embeddingModel = await this.#pickProviderModel(
            "Select embedding model",
            models,
            current?.embedding.model,
        );
        if (typeof embeddingModel !== "string") return undefined;
        const embeddingSuffix = await this.#input(
            title,
            "Embedding suffix (empty uses none)",
            current?.embedding.embeddingSuffix ?? "",
        );
        if (embeddingSuffix === undefined) return undefined;
        this.#append(`Inspecting embedding model ${embeddingModel}…`, "muted");
        let detectedDimensions: number;
        try {
            detectedDimensions = (await profileService.inspectEmbeddingModel(
                embeddingModel,
                baseUrl || undefined,
                embeddingSuffix || undefined,
            )).dimensions;
        } catch (error: unknown) {
            const unchangedExistingEmbedding = current !== undefined &&
                embeddingModel === current.embedding.model &&
                baseUrl === (current.embedding.baseUrl ??
                    "http://127.0.0.1:1234/v1") &&
                embeddingSuffix === (current.embedding.embeddingSuffix ?? "");
            if (!unchangedExistingEmbedding) throw error;
            detectedDimensions = current.embedding.dimensions;
            this.#append(
                `Could not inspect the unchanged embedding model; retaining ${detectedDimensions} dimensions. ${formatError(error)}`,
                "warning",
            );
        }
        const dimensionsText = await this.#input(
            title,
            "Embedding dimensions",
            String(detectedDimensions),
        );
        if (dimensionsText === undefined) return undefined;
        const dimensions = parsePositiveInteger(
            dimensionsText,
            "Embedding dimensions",
        );
        const maximumInputsText = await this.#input(
            title,
            "Embedding batch size (empty uses default)",
            current?.embedding.maximumInputs === undefined
                ? ""
                : String(current.embedding.maximumInputs),
        );
        if (maximumInputsText === undefined) return undefined;
        const maximumInputs = parseOptionalPositiveInteger(
            maximumInputsText,
            "Embedding batch size",
        );
        const rerankingModel = await this.#pickProviderModel(
            "Select reranker model",
            models,
            current?.reranking?.model,
            true,
        );
        if (rerankingModel === undefined) return undefined;

        let reranking: ProviderProfileInput["reranking"];
        if (rerankingModel !== null) {
            const provider = await this.#pickRerankingInterface(
                current?.reranking?.provider,
            );
            if (provider === undefined) return undefined;
            if (provider === "openai-compatible-rerank") {
                reranking = {
                    provider,
                    model: rerankingModel,
                    ...(baseUrl ? { baseUrl } : {}),
                };
            } else {
                const currentInstruction = current?.reranking !== undefined &&
                        current.reranking.provider !== "openai-compatible-rerank"
                    ? current.reranking.instruction
                    : undefined;
                const instruction = await this.#input(
                    title,
                    "Reranker instruction (empty uses default)",
                    currentInstruction ?? "",
                );
                if (instruction === undefined) return undefined;
                reranking = {
                    provider,
                    model: rerankingModel,
                    ...(baseUrl ? { baseUrl } : {}),
                    ...(instruction.trim().length === 0
                        ? {}
                        : { instruction: instruction.trim() }),
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
        this.#append("Discovering provider models…", "muted");
        try {
            const models = await profileService.listProviderModels(baseUrl);
            if (models.length === 0) {
                throw new Error("The provider did not return any models");
            }
            return models;
        } catch (error: unknown) {
            if (current === undefined) throw error;
            this.#append(
                `Could not refresh provider models; current model IDs and manual entry remain available. ${formatError(error)}`,
                "warning",
            );
            return [
                { id: current.embedding.model },
                ...(current.reranking === undefined
                    ? []
                    : [{ id: current.reranking.model }]),
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
        if (
            currentModel !== undefined &&
            !unique.some(({ id }) => id === currentModel)
        ) {
            unique.push({ id: currentModel });
        }
        unique.sort((left, right) => {
            if (left.id === currentModel) return -1;
            if (right.id === currentModel) return 1;
            return left.id.localeCompare(right.id);
        });
        const items: SelectItem[] = [];
        if (allowDisabled && currentModel === undefined) {
            items.push({
                value: "__disabled",
                label: "Disable reranking",
                description: "Current",
            });
        }
        unique.forEach((model, index) => {
            const description = [
                model.id === currentModel ? "Current" : undefined,
                model.ownedBy,
            ].filter(Boolean).join(" · ");
            items.push({
                value: `model:${index}`,
                label: model.id,
                ...(description.length === 0 ? {} : { description }),
            });
        });
        if (allowDisabled && currentModel !== undefined) {
            items.push({
                value: "__disabled",
                label: "Disable reranking",
            });
        }
        items.push({
            value: "__manual",
            label: "Enter model ID manually",
            description: "Use an ID absent from provider discovery",
        });
        const selection = await this.#pick(title, items);
        if (selection === undefined) return undefined;
        if (selection.value === "__disabled") return null;
        if (selection.value === "__manual") {
            const manual = (await this.#input(
                title,
                "Model ID",
                currentModel ?? "",
            ))?.trim();
            if (manual === undefined) return undefined;
            if (manual.length === 0) throw new Error("Model ID must not be empty");
            return manual;
        }
        const index = Number.parseInt(selection.value.slice("model:".length), 10);
        return unique[index]?.id;
    }

    async #renameProfile(profile: ProviderProfile): Promise<void> {
        const nextName = (await this.#input(
            `Rename ${profile.name}`,
            "New name",
            profile.name,
        ))?.trim();
        if (!nextName || nextName === profile.name) return;
        const savedApiKey = await this.#storedApiKey(profile.name);
        const result = await this.#profileRenames.rename(profile.name, nextName);
        let updatedPreferences = 0;
        let preferencesUpdated = false;
        try {
            updatedPreferences = await this.#preferences.replaceProfileReferences(
                profile.name,
                result.profile.name,
            );
            preferencesUpdated = true;
            if (savedApiKey !== undefined && !await this.#credentials.rename(profile.name, result.profile.name)) {
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
        this.#activePreference = this.#activeProject
            ? await this.#preferences.get(this.#activeProject.projectIdentifier)
            : undefined;
        if (savedApiKey !== undefined) {
            this.#storedApiKeyCache.delete(profile.name);
            this.#storedApiKeyCache.set(result.profile.name, savedApiKey);
        }
        const apiKey = this.#sessionApiKeys.get(profile.name);
        if (apiKey !== undefined) {
            this.#sessionApiKeys.delete(profile.name);
            this.#sessionApiKeys.set(result.profile.name, apiKey);
        }
        this.#append(
            `Renamed profile ${profile.name} to ${result.profile.name}; updated ${result.updatedPresets} preset(s), ${result.updatedProjectRecipes} project recipe(s), and ${updatedPreferences} TUI project preference(s).`,
            "success",
        );
        this.#updateHeader();
    }

    async #managePresets(argument = ""): Promise<void> {
        if (this.#live?.running) {
            this.#append("Stop live indexing before changing indexing presets.", "warning");
            return;
        }
        const presets = await this.#presets.list();
        const direct = argument ? presets.find(({ name }) => name === argument) : undefined;
        const selection = direct ? { value: direct.name, label: direct.name } : await this.#pick("Indexing presets", [
            { value: "__create", label: "+ Create preset", description: "Define code indexing rules" },
            ...presets.map((preset) => ({
                value: preset.name,
                label: preset.name,
                description: `${preset.maximumChunkSize ?? "default"} chars · ${preset.exclude?.length ?? 0} excludes`,
            })),
        ]);
        if (!selection) return;
        if (selection.value === "__create") {
            await this.#createPreset();
            return;
        }
        const preset = presets.find(({ name }) => name === selection.value)!;
        const action = await this.#pick(preset.name, [
            { value: "use", label: "Use for current project" },
            { value: "edit", label: "Edit preset" },
            {
                value: "edit-json",
                label: "Edit JSON",
                description: "Open validated preset JSON in a terminal editor",
            },
            { value: "rename", label: "Rename" },
            { value: "show", label: "Show configuration" },
            { value: "delete", label: "Delete preset" },
        ]);
        if (!action) return;
        if (action.value === "use") {
            if (!this.#activeProject || !this.#activePreference) {
                this.#append("Select a profile during /index before changing an existing project preset.", "warning");
                return;
            }
            this.#activePreference = await this.#preferences.set({ ...this.#activePreference, preset: preset.name });
            this.#append(`Project preset changed to ${preset.name}.`, "success");
            this.#updateHeader();
        } else if (action.value === "edit") {
            await this.#editPreset(preset);
        } else if (action.value === "edit-json") {
            await this.#editPresetJson(preset);
        } else if (action.value === "rename") {
            await this.#renamePreset(preset);
        } else if (action.value === "show") {
            this.#append(JSON.stringify(preset, null, 2));
        } else if (action.value === "delete") {
            const used = (await this.#preferences.list()).filter(({ preset: value }) => value === preset.name);
            if (used.length > 0) {
                this.#append(`Preset ${preset.name} is used by ${used.length} project(s) and cannot be deleted.`, "warning");
                return;
            }
            if (await this.#confirm(`Delete preset ${preset.name}?`)) {
                await this.#presets.remove(preset.name);
                this.#append(`Deleted preset ${preset.name}.`, "success");
            }
        }
    }

    async #createPreset(): Promise<void> {
        const name = (await this.#input("Create indexing preset", "Name"))?.trim();
        if (!name) return;
        const configuration = await this.#promptPresetConfiguration(
            "Create indexing preset",
            name,
        );
        if (configuration === undefined) return;
        const saved = await this.#presets.set(configuration);
        this.#append(`Created preset ${saved.name}.`, "success");
    }

    async #editPreset(preset: IndexingPreset): Promise<void> {
        const configuration = await this.#promptPresetConfiguration(
            `Edit ${preset.name}`,
            preset.name,
            preset,
        );
        if (configuration === undefined) return;
        await this.#presets.set(configuration);
        this.#append(`Updated preset ${preset.name}.`, "success");
    }

    async #editPresetJson(preset: IndexingPreset): Promise<void> {
        const edited = await this.#editConfigurationJson(
            editablePreset(preset),
            `preset-${preset.name}`,
        );
        if (edited === undefined) {
            this.#append(`Preset ${preset.name} was not changed.`, "muted");
            return;
        }
        const input = requireEditedPreset(
            edited,
            preset.name,
        );
        await this.#presets.set(input);
        this.#append(`Updated preset ${preset.name} from JSON.`, "success");
    }

    async #promptPresetConfiguration(
        title: string,
        name: string,
        current?: IndexingPreset,
    ): Promise<IndexingPresetInput | undefined> {
        const profiles = await this.#profiles.list();
        if (profiles.length === 0) {
            throw new Error("Create a provider profile before creating a preset");
        }
        const providerProfile = await this.#pickProfile(
            profiles,
            "Select provider profile",
            current?.providerProfile ?? this.#activePreference?.profile,
        );
        if (providerProfile === undefined) return undefined;
        const chunkText = await this.#input(
            title,
            "Maximum chunk size",
            String(current?.maximumChunkSize ?? 3_000),
        );
        if (chunkText === undefined) return undefined;
        const maximumChunkSize = parsePositiveInteger(
            chunkText,
            "Maximum chunk size",
        );
        const includeText = await this.#input(
            title,
            "Include globs (comma separated)",
            current?.include?.join(", ") ?? "",
        );
        if (includeText === undefined) return undefined;
        const excludeText = await this.#input(
            title,
            "Exclude globs (comma separated)",
            current?.exclude?.join(", ") ?? "",
        );
        if (excludeText === undefined) return undefined;
        const windows1251 = await this.#confirm(
            "Enable Windows-1251 fallback?",
            current?.windows1251 === true,
        );
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

    async #renamePreset(preset: IndexingPreset): Promise<void> {
        const nextName = (await this.#input(
            `Rename ${preset.name}`,
            "New name",
            preset.name,
        ))?.trim();
        if (!nextName || nextName === preset.name) return;
        const renamed = await this.#presets.rename(preset.name, nextName);
        let updatedPreferences = 0;
        try {
            updatedPreferences = await this.#preferences.replacePresetReferences(
                preset.name,
                renamed.name,
            );
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
        this.#activePreference = this.#activeProject
            ? await this.#preferences.get(this.#activeProject.projectIdentifier)
            : undefined;
        this.#append(
            `Renamed preset ${preset.name} to ${renamed.name}; updated ${updatedPreferences} TUI project preference(s).`,
            "success",
        );
        this.#updateHeader();
    }

    async #browseBuilds(): Promise<void> {
        const project = this.#requiredProject();
        const storage = new SqliteStorageProvider(project.databasePath, { readOnly: true, immutable: true });
        try {
            const builds = await storage.listBuilds();
            if (builds.length === 0) {
                this.#append("This project has no builds.", "muted");
                return;
            }
            const selection = await this.#pick("Build history", builds.map((build) => ({
                value: build.indexBuildId,
                label: `${build.indexBuildId.slice(0, 12)}  ${build.status}`,
                description: `${build.modelIdentity.model} · ${relativeTime(build.completedAt ?? build.createdAt)}`,
            })));
            const build = builds.find(({ indexBuildId }) => indexBuildId === selection?.value);
            if (build) this.#append(JSON.stringify(build, null, 2));
        } finally {
            await storage.close();
        }
    }

    async #manageTargets(): Promise<void> {
        if (this.#live?.running) {
            this.#append("Live mode owns the active retrieval target. Stop it before changing targets manually.", "warning");
            return;
        }
        const project = this.#requiredProject();
        const listing = await this.#targets.list(project.projectIdentifier, this.#cwd);
        const targets = Array.isArray(listing.targets) ? listing.targets.filter(isRecord) : [];
        if (targets.length === 0) {
            this.#append("This project has no named retrieval targets.", "muted");
            return;
        }
        const selection = await this.#pick("Retrieval targets", targets.map((target) => ({
            value: String(target.name),
            label: `${target.active === true ? "●" : "○"} ${String(target.name)}`,
            description: String(target.indexBuildId ?? ""),
        })));
        if (!selection) return;
        const action = await this.#pick(selection.label, [
            { value: "switch", label: "Make active" },
            { value: "rename", label: "Rename" },
            { value: "remove", label: "Remove target" },
        ]);
        if (!action) return;
        if (action.value === "switch") {
            await this.#targets.switchTarget(project.projectIdentifier, selection.value, this.#cwd);
            this.#append(`Activated target ${selection.value}.`, "success");
        } else if (action.value === "rename") {
            const next = (await this.#input(`Rename ${selection.value}`, "New name", selection.value))?.trim();
            if (next && next !== selection.value) {
                await this.#targets.renameTarget(project.projectIdentifier, selection.value, next, this.#cwd);
                this.#append(`Renamed ${selection.value} to ${next}.`, "success");
            }
        } else if (action.value === "remove" && await this.#confirm(`Remove target ${selection.value}?`)) {
            await this.#targets.removeTarget(project.projectIdentifier, selection.value, this.#cwd);
            this.#append(`Removed target ${selection.value}.`, "success");
        }
    }

    async #inspectChunks(argument: string): Promise<void> {
        const project = this.#requiredProject();
        const path = argument || await this.#input("Inspect indexed chunks", "Relative path");
        if (!path?.trim()) return;
        const result = await this.#inspection.chunks({
            projectReference: project.projectIdentifier,
            path: path.trim(),
        }, this.#cwd);
        const lines = result.chunks.chunks.map((chunk, index) => {
            return [
                `Chunk ${index + 1} · lines ${chunk.metadata.startLine}–${chunk.metadata.endLine}`,
                chunk.content,
            ].join("\n");
        });
        this.#append(`${path.trim()} · build ${result.indexBuildId.slice(0, 12)}\n\n${lines.join("\n\n")}`);
    }

    async #manageCollections(): Promise<void> {
        const context = await this.#collectionService();
        if (!context) return;
        const { service, profileName } = context;
        const collections = await service.listCollections();
        const selection = await this.#pick("Document collections", [
            { value: "__create", label: "+ Create collection", description: "Create an externally managed document set" },
            ...collections.map((collection) => ({
                value: collection.collectionId,
                label: collection.name,
                description: `${collection.sourceCount} sources · ${collection.needsBuild ? "build required" : "ready"}`,
            })),
        ]);
        if (!selection) return;
        if (selection.value === "__create") {
            const name = (await this.#input("Create document collection", "Name"))?.trim();
            if (!name) return;
            const created = await service.createCollection(name);
            this.#append(`Created collection ${created.name}.`, "success");
            return;
        }
        const collection = collections.find(({ collectionId }) => collectionId === selection.value)!;
        const action = await this.#pick(collection.name, [
            { value: "search", label: "Search collection" },
            { value: "index", label: "Index collection", description: profileName },
            { value: "sources", label: "Browse sources", description: `${collection.sourceCount} sources` },
            { value: "add", label: "Add local files" },
            { value: "delete", label: "Delete collection" },
        ]);
        if (!action) return;
        if (action.value === "search") {
            await this.#searchCollection(service, collection);
        } else if (action.value === "index") {
            await this.#configureCollectionIndex(service, collection, profileName);
        } else if (action.value === "sources") {
            await this.#manageCollectionSources(service, collection);
        } else if (action.value === "add") {
            await this.#addCollectionSources(service, collection);
        } else if (action.value === "delete" && await this.#confirm(`Delete collection ${collection.name}?`, false)) {
            await service.deleteCollection(collection.collectionId);
            this.#append(`Deleted collection ${collection.name}.`, "success");
        }
    }

    async #collectionService(): Promise<{
        service: CollectionServiceType;
        profileName: string;
    } | undefined> {
        const profiles = await this.#profiles.list();
        const profileName = await this.#searchProfile() ?? profiles[0]?.name;
        if (!profileName) {
            this.#append("Create a provider profile before using collections.", "warning");
            return undefined;
        }
        const profileService = await this.#profileService(profileName);
        const profile = await profileService.get(profileName);
        const rerankingProvider = profileService.createRerankingProvider(profile);
        return {
            profileName,
            service: new CollectionService({
                embeddingProvider: profileService.createEmbeddingProvider(profile),
                ...(rerankingProvider === undefined ? {} : { rerankingProvider }),
            }),
        };
    }

    async #searchCollection(service: CollectionServiceType, collection: CollectionSummary): Promise<void> {
        const query = await this.#input(`Search ${collection.name}`, "Query");
        if (!query?.trim()) return;
        const results = await service.retrieve(collection.collectionId, {
            query: query.trim(),
            limit: 10,
            context: { beforeChunks: 1, afterChunks: 1, maximumCharacters: 12_000 },
            rerank: { candidateLimit: 30, failureMode: "use-semantic-order" },
        });
        const component = new SearchResultsComponent({
            query: query.trim(),
            results,
            requestRender: () => this.#ui.requestRender(),
            onDone: () => this.#ui.setFocus(this.#editor),
        });
        this.#transcript.addChild(component);
        this.#transcript.addChild(new Spacer(1));
        if (results.length > 0) this.#ui.setFocus(component);
    }

    async #configureCollectionIndex(
        service: CollectionServiceType,
        collection: CollectionSummary,
        profileName: string,
    ): Promise<void> {
        if (this.#live?.running) {
            this.#append("Stop live indexing before starting another indexing operation.", "warning");
            return;
        }
        if (this.#activeJob) {
            this.#append(`An index is already running for ${basename(this.#activeJob.root)}.`, "warning");
            return;
        }
        const presets = await this.#presets.list();
        if (presets.length === 0) {
            this.#append("Create an indexing preset with /preset before indexing a collection.", "warning");
            return;
        }
        const preferredPreset = this.#activePreference?.preset;
        const preset = presets.find(({ name }) => name === preferredPreset) ??
            await this.#selectPresetValue(presets, "Select collection indexing preset");
        if (!preset) return;
        if (!await this.#confirm(`Index ${collection.name} with ${profileName} · ${preset.name}?`)) return;
        void this.#startCollectionIndex(service, collection, preset);
    }

    async #selectPresetValue(
        presets: readonly IndexingPreset[],
        title: string,
    ): Promise<IndexingPreset | undefined> {
        const name = await this.#pickPreset(presets, title);
        return presets.find((preset) => preset.name === name);
    }

    async #startCollectionIndex(
        service: CollectionServiceType,
        collection: CollectionSummary,
        preset: IndexingPreset,
    ): Promise<void> {
        const controller = new AbortController();
        this.#activeJob = {
            root: `collection:${collection.name}`,
            controller,
            startedAt: Date.now(),
        };
        this.#progress = new IndexingProgressComponent();
        this.#progress.setState({ stage: "provider", message: `Preparing ${collection.name}` });
        this.#progressArea.addChild(this.#progress);
        this.#progressTimer = setInterval(() => {
            this.#progress?.tick();
            this.#ui.requestRender();
        }, 90);
        this.#updateHeader();
        this.#ui.terminal.setProgress(true);

        try {
            const sources = await service.listSources(collection.collectionId);
            const sourcePaths = new Map(sources.map((source) => [source.sourceId, source.logicalPath]));
            const result = await service.buildCollection(collection.collectionId, {
                ...(preset.maximumChunkSize === undefined ? {} : { maximumChunkSize: preset.maximumChunkSize }),
                ...(preset.windows1251 === true ? { encodingFallback: "windows-1251" as const } : {}),
                signal: controller.signal,
                onProgress: (progress) => {
                    const mapped: IndexingProgress = {
                        phase: progress.phase,
                        completed: progress.completed,
                        total: progress.total,
                        ...(progress.currentSourceId === undefined
                            ? {}
                            : { currentPath: sourcePaths.get(progress.currentSourceId) ?? progress.currentSourceId }),
                        discoveredFiles: sources.length,
                        ...(progress.reusedDocuments === undefined ? {} : { reusedDocuments: progress.reusedDocuments }),
                        ...(progress.reusedChunks === undefined ? {} : { reusedChunks: progress.reusedChunks }),
                        ...(progress.reusedEmbeddings === undefined ? {} : { reusedEmbeddings: progress.reusedEmbeddings }),
                        ...(progress.generatedEmbeddings === undefined ? {} : { generatedEmbeddings: progress.generatedEmbeddings }),
                    };
                    if (this.#activeJob) this.#activeJob.progress = mapped;
                    this.#progress?.setState({ stage: "indexing", progress: mapped });
                    this.#ui.requestRender();
                },
            });
            this.#append(
                `✓ Indexed collection ${collection.name} in ${formatDuration(Date.now() - this.#activeJob.startedAt)}\n` +
                `  ${result.sourceCount} sources · ${result.indexedChunks} chunks · ` +
                `${result.reusedEmbeddings} embeddings reused · build ${result.indexBuildId.slice(0, 12)}…`,
                "success",
            );
        } catch (error: unknown) {
            if (controller.signal.aborted) {
                this.#append(`Indexing collection ${collection.name} was cancelled.`, "warning");
            } else {
                this.#appendError(error);
            }
        } finally {
            this.#stopProgress();
            this.#activeJob = undefined;
            this.#ui.terminal.setProgress(false);
            this.#updateHeader();
            this.#ui.requestRender();
        }
    }

    async #manageCollectionSources(service: CollectionServiceType, collection: CollectionSummary): Promise<void> {
        const sources = await service.listSources(collection.collectionId);
        if (sources.length === 0) {
            this.#append(`Collection ${collection.name} has no sources.`, "muted");
            return;
        }
        const selected = await this.#pick(`${collection.name} sources`, sources.map((source) => ({
            value: source.sourceId,
            label: source.logicalPath,
            description: source.tags.length > 0 ? source.tags.join(", ") : `${source.byteLength} bytes`,
        })));
        if (!selected) return;
        const source = sources.find(({ sourceId }) => sourceId === selected.value)!;
        const action = await this.#pick(source.logicalPath, [
            { value: "show", label: "Show source details" },
            { value: "tags", label: "Set tags" },
            { value: "remove", label: "Remove source" },
        ]);
        if (!action) return;
        if (action.value === "show") {
            this.#append(JSON.stringify(source, null, 2));
        } else if (action.value === "tags") {
            const tags = await this.#input("Set source tags", "Comma separated", source.tags.join(", "));
            if (tags === undefined) return;
            await service.setSourceTags(collection.collectionId, [source.sourceId], splitPatterns(tags));
            this.#append(`Updated tags for ${source.logicalPath}.`, "success");
        } else if (action.value === "remove" && await this.#confirm(`Remove ${source.logicalPath}?`, false)) {
            await service.removeSources(collection.collectionId, [source.sourceId]);
            this.#append(`Removed ${source.logicalPath} from ${collection.name}.`, "success");
        }
    }

    async #addCollectionSources(service: CollectionServiceType, collection: CollectionSummary): Promise<void> {
        const pathsText = await this.#input("Add local files", "Paths (comma separated)");
        if (!pathsText?.trim()) return;
        const paths = splitPatterns(pathsText).map((path) => resolve(this.#cwd, path));
        const tagsText = await this.#input("Tags for added sources", "Comma separated", "");
        if (tagsText === undefined) return;
        const documents = await Promise.all(paths.map(async (path) => ({
            externalId: path,
            content: new Uint8Array(await readFile(path)),
            logicalPath: basename(path),
            title: basename(path),
            mediaType: mediaTypeFor(path),
            ...(splitPatterns(tagsText).length === 0 ? {} : { tags: splitPatterns(tagsText) }),
            originalLocation: path,
        })));
        const manifest = await service.upsertDocuments(collection.collectionId, documents);
        this.#append(`Added ${documents.length} source(s) to ${manifest.name}. Run /collection and choose Index collection.`, "success");
    }

    #showJobs(): void {
        if (this.#live?.running && this.#liveStatus !== undefined) {
            const status = this.#liveStatus;
            this.#append([
                `Live indexing ${status.root}`,
                `Phase: ${status.phase} · generation ${status.generation}`,
                `Branch: ${status.branch ?? "unknown"} · target ${status.target ?? "pending"}`,
                `Updated: ${relativeTime(status.updatedAt)}`,
            ].join("\n"));
            return;
        }
        if (!this.#activeJob) {
            this.#append("No indexing operation is running.", "muted");
            return;
        }
        const progress = this.#activeJob.progress;
        this.#append([
            `Indexing ${this.#activeJob.root}`,
            `Elapsed: ${formatDuration(Date.now() - this.#activeJob.startedAt)}`,
            progress ? `Phase: ${progress.phase} · ${progress.completed ?? "?"}/${progress.total ?? "?"}` : "Checking provider",
        ].join("\n"));
    }

    async #openSearchResult(result: RetrievalResult): Promise<void> {
        const root = this.#activeProject?.root;
        if (!root) {
            this.#append("Only project search results can be opened in a local editor.", "warning");
            return;
        }
        const specification = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "nano";
        const [command, ...configuredArguments] = specification.split(/\s+/u);
        if (!command) return;
        const path = resolve(root, result.path);
        const editorName = basename(command);
        const locationArguments = ["code", "code-insiders", "codium", "cursor"].includes(editorName)
            ? ["--goto", `${path}:${result.range.startLine}`]
            : [`+${result.range.startLine}`, path];
        if (this.#activeJob) {
            this.#append("Wait for the current manual index to finish before opening an external editor.", "warning");
            return;
        }
        this.#terminalSuspended = true;
        this.#ui.stop({ preserveScreen: true });
        let failure: unknown;
        try {
            await new Promise<void>((resolveEditor, rejectEditor) => {
                const child = spawn(command, [...configuredArguments, ...locationArguments], {
                    stdio: "inherit",
                });
                child.once("error", rejectEditor);
                child.once("exit", (code, signal) => {
                    if (code === 0 || signal !== null) resolveEditor();
                    else rejectEditor(new Error(`${editorName} exited with status ${code ?? "unknown"}`));
                });
            });
        } catch (error: unknown) {
            failure = error;
        } finally {
            this.#terminalSuspended = false;
            this.#ui.start();
            const status = this.#liveStatus;
            if (
                status?.phase === "pending" ||
                status?.phase === "indexing" ||
                status?.phase === "starting"
            ) {
                this.#ensureLiveProgress(status);
            } else if (this.#live?.running) {
                this.#stopProgress();
                this.#ui.terminal.setProgress(false);
            }
            this.#ui.requestRender(true);
        }
        if (failure !== undefined) this.#appendError(failure);
    }

    async #showMcp(): Promise<void> {
        const project = this.#requiredProject();
        const profile = this.#activePreference?.profile;
        const configuration = JSON.stringify({
            "scribery": {
                type: "stdio",
                command: "scribery-mcp",
                args: [
                    "--project",
                    project.root ?? project.projectIdentifier,
                    ...(profile ? ["--profile", profile] : []),
                    "--tools",
                    "vector_search",
                ],
            },
        }, null, 2);
        const action = await this.#pick("MCP configuration", [
            { value: "copy", label: "Copy JSON", description: "Use terminal clipboard support" },
            { value: "print", label: "Print JSON", description: "Leave configuration in scrollback" },
        ]);
        if (action?.value === "copy") {
            this.#ui.terminal.write(`\u001b]52;c;${Buffer.from(configuration).toString("base64")}\u0007`);
            this.#append("Copied MCP configuration to the clipboard.", "success");
        } else if (action?.value === "print") {
            this.#append(configuration);
        }
    }

    async #doctor(): Promise<void> {
        const profiles = await this.#profiles.list();
        const selected = this.#activePreference?.profile ?? await this.#pickProfile(profiles, "Select profile to test");
        if (!selected) return;
        await this.#diagnoseProfile(selected);
    }

    async #showSettings(): Promise<void> {
        const credentialStatus = await this.#credentialsAvailable()
            ? `${this.#credentials.displayName} is available for secure, persistent per-profile keys.`
            : `${this.#credentials.displayName} is unavailable; session and environment keys still work.`;
        this.#append([
            "Terminal interaction",
            "",
            "  /             open fuzzy command completion",
            "  ↑ / ↓         navigate options or input history",
            "  Enter         select or submit",
            "  Tab           complete command or path",
            "  Escape        close a selector; confirms before cancelling indexing",
            "  Ctrl+C twice  quit",
            "",
            `API keys can be saved per profile in ${this.#credentials.displayName} or kept only for this session.`,
            credentialStatus,
            "Resolution order: session key, saved key, OPENAI_COMPATIBLE_API_KEY.",
            "",
            "Project preferences are stored outside repositories under ~/.scribery/tui.",
        ].join("\n"));
    }

    async #searchProfile(): Promise<string | undefined> {
        if (this.#activePreference?.profile) return this.#activePreference.profile;
        if (!this.#activeProject) return undefined;
        try {
            const recipe = await this.#indexing.recipe(this.#activeProject.projectIdentifier, this.#cwd);
            return recipe?.provider.type === "profile" ? recipe.provider.profile : undefined;
        } catch {
            return undefined;
        }
    }

    async #refreshProjects(preferredIdentifier?: string): Promise<void> {
        this.#projects = await listIndexedProjects();
        const identifier = preferredIdentifier ?? this.#activeProject?.projectIdentifier;
        this.#activeProject = identifier
            ? this.#projects.find(({ projectIdentifier }) => projectIdentifier === identifier)
            : projectForDirectory(this.#projects, this.#cwd);
        this.#activePreference = this.#activeProject
            ? await this.#preferences.get(this.#activeProject.projectIdentifier)
            : undefined;
        this.#updateHeader();
    }

    #updateHeader(): void {
        this.#header.setState({
            ...(this.#activeProject === undefined ? {} : { project: this.#activeProject }),
            ...(this.#activePreference === undefined ? {} : { preference: this.#activePreference }),
            indexing: this.#activeJob !== undefined,
            ...(this.#liveStatus === undefined ? {} : { live: this.#liveStatus }),
        });
        this.#promptLabel.setState(this.#activeProject?.root, false);
        this.#footer.setLocation(this.#cwd, this.#activeProject?.root);
        if (!this.#terminalSuspended) this.#ui.requestRender();
    }

    #append(message: string, tone: "normal" | "muted" | "success" | "warning" = "normal"): void {
        const styled = tone === "muted" ? colors.muted(message)
            : tone === "success" ? colors.success(message)
                : tone === "warning" ? colors.warning(message)
                    : message;
        this.#transcript.addChild(new Text(styled, 0, 0));
        this.#transcript.addChild(new Spacer(1));
        if (!this.#terminalSuspended) this.#ui.requestRender();
    }

    #appendError(error: unknown): void {
        this.#append(formatError(error), "warning");
    }

    async #pick(title: string, items: readonly SelectItem[]): Promise<SelectItem | undefined> {
        if (items.length === 0) return undefined;
        return new Promise((resolveSelection) => {
            this.#modalActive = true;
            let settled = false;
            const finish = (item?: SelectItem): void => {
                if (settled) return;
                settled = true;
                this.#modalActive = false;
                this.#ui.removeChild(picker);
                this.#ui.addChild(this.#editorArea);
                this.#ui.setFocus(this.#editor);
                this.#ui.requestRender(true);
                resolveSelection(item);
            };
            const picker = new Picker({
                title,
                items,
                onSelect: (item) => finish(item),
                onCancel: () => finish(),
                requestRender: () => this.#ui.requestRender(),
            });
            this.#ui.removeChild(this.#editorArea);
            this.#ui.addChild(picker);
            this.#ui.setFocus(picker);
            this.#ui.requestRender(true);
        });
    }

    async #input(title: string, label: string, initialValue?: string): Promise<string | undefined> {
        return this.#promptInput(title, label, initialValue, false);
    }

    async #secretInput(title: string, label: string): Promise<string | undefined> {
        return this.#promptInput(title, label, undefined, true);
    }

    async #promptInput(
        title: string,
        label: string,
        initialValue: string | undefined,
        maskInput: boolean,
    ): Promise<string | undefined> {
        return new Promise((resolveInput) => {
            this.#modalActive = true;
            let settled = false;
            const finish = (value?: string): void => {
                if (settled) return;
                settled = true;
                this.#modalActive = false;
                this.#ui.removeChild(prompt);
                this.#ui.addChild(this.#editorArea);
                this.#ui.setFocus(this.#editor);
                this.#ui.requestRender(true);
                resolveInput(value);
            };
            const prompt = new TextPrompt({
                title,
                label,
                ...(initialValue === undefined ? {} : { initialValue }),
                ...(maskInput ? { maskInput: true } : {}),
                onSubmit: (value) => finish(value),
                onCancel: () => finish(),
                requestRender: () => this.#ui.requestRender(),
            });
            this.#ui.removeChild(this.#editorArea);
            this.#ui.addChild(prompt);
            this.#ui.setFocus(prompt);
            this.#ui.requestRender(true);
        });
    }

    async #credentialsAvailable(): Promise<boolean> {
        this.#credentialAvailability ??= this.#credentials.isAvailable();
        return this.#credentialAvailability;
    }

    async #storedApiKey(profileName: string): Promise<string | undefined> {
        if (this.#storedApiKeyCache.has(profileName)) {
            return this.#storedApiKeyCache.get(profileName) ?? undefined;
        }
        if (!await this.#credentialsAvailable()) {
            this.#storedApiKeyCache.set(profileName, null);
            return undefined;
        }
        const apiKey = await this.#credentials.get(profileName);
        this.#storedApiKeyCache.set(profileName, apiKey ?? null);
        return apiKey;
    }

    async #apiKey(profileName: string): Promise<string | undefined> {
        return this.#sessionApiKeys.get(profileName)
            ?? await this.#storedApiKey(profileName)
            ?? this.#environmentApiKey;
    }

    async #apiKeySource(profileName: string): Promise<string> {
        if (this.#sessionApiKeys.has(profileName)) return "from this session";
        if (await this.#storedApiKey(profileName) !== undefined) return `from ${this.#credentials.displayName}`;
        return this.#environmentApiKey === undefined ? "not set" : "from the environment";
    }

    async #profileService(profileName: string): Promise<ProviderProfileService> {
        return new ProviderProfileService(apiKeyOptions(await this.#apiKey(profileName)));
    }

    async #indexingService(profileName: string): Promise<ProjectIndexingService> {
        return new ProjectIndexingService(apiKeyOptions(await this.#apiKey(profileName)));
    }

    async #searchService(profileName: string): Promise<ProjectSearchService> {
        return new ProjectSearchService(apiKeyOptions(await this.#apiKey(profileName)));
    }

    async #diagnoseProfile(profileName: string): Promise<void> {
        this.#append(`Testing ${profileName}…`, "muted");
        const profileService = await this.#profileService(profileName);
        this.#append(JSON.stringify(await profileService.diagnose(profileName), null, 2), "success");
    }

    async #editConfigurationJson(
        value: unknown,
        label: string,
    ): Promise<unknown | undefined> {
        if (this.#activeJob !== undefined || this.#live?.running) {
            throw new Error(
                "JSON configuration editing is unavailable while indexing is active",
            );
        }
        return editJsonConfiguration(value, label, {
            beforeSpawn: () => this.#ui.stop(),
            afterSpawn: () => {
                this.#ui.start();
                this.#ui.terminal.setTitle("Scribery");
                this.#ui.setFocus(this.#editor);
                this.#ui.requestRender(true);
            },
        });
    }

    async #confirm(title: string, defaultYes = true): Promise<boolean> {
        const selected = await this.#pick(title, defaultYes ? [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
        ] : [
            { value: "no", label: "No" },
            { value: "yes", label: "Yes" },
        ]);
        return selected?.value === "yes";
    }

    async #pickProfile(
        profiles: readonly ProviderProfile[],
        title: string,
        currentName?: string,
    ): Promise<string | undefined> {
        const ordered = [...profiles].sort((left, right) => {
            if (left.name === currentName) return -1;
            if (right.name === currentName) return 1;
            return left.name.localeCompare(right.name);
        });
        const selection = await this.#pick(title, ordered.map((profile) => ({
            value: profile.name,
            label: profile.name,
            description: `${profile.name === currentName ? "Current · " : ""}${profile.embedding.model} · ${profile.embedding.dimensions} dimensions · ${this.#rerankingSummary(profile)}`,
        })));
        return selection?.value;
    }

    async #pickRerankingInterface(
        currentProvider?: NonNullable<ProviderProfile["reranking"]>["provider"],
    ): Promise<"openai-compatible-rerank" | "openai-compatible-qwen3" | undefined> {
        const current = currentProvider === "openai-compatible-rerank"
            ? "openai-compatible-rerank"
            : currentProvider === undefined
                ? undefined
                : "openai-compatible-qwen3";
        const dedicated: SelectItem = {
            value: "openai-compatible-rerank",
            label: "Dedicated /v1/rerank",
            description: current === "openai-compatible-rerank"
                ? "Current · recommended for oMLX"
                : "Recommended for oMLX",
        };
        const completions: SelectItem = {
            value: "openai-compatible-qwen3",
            label: "Legacy /v1/completions",
            description: current === "openai-compatible-qwen3"
                ? "Current · Qwen3 yes/no next-token scoring"
                : "Qwen3 yes/no next-token scoring",
        };
        const selection = await this.#pick(
            "Reranking interface",
            current === "openai-compatible-qwen3"
                ? [completions, dedicated]
                : [dedicated, completions],
        );
        return selection?.value === "openai-compatible-rerank" ||
            selection?.value === "openai-compatible-qwen3"
            ? selection.value
            : undefined;
    }

    #rerankingSummary(profile: ProviderProfile): string {
        if (profile.reranking === undefined) return "reranking off";
        return profile.reranking.provider === "openai-compatible-rerank"
            ? "rerank /v1/rerank"
            : "rerank /v1/completions";
    }

    async #pickPreset(presets: readonly IndexingPreset[], title: string): Promise<string | undefined> {
        const selection = await this.#pick(title, presets.map((preset) => ({
            value: preset.name,
            label: preset.name,
            description: `${preset.maximumChunkSize ?? "default"} chars · ${preset.exclude?.length ?? 0} excludes`,
        })));
        return selection?.value;
    }

    #requiredProject(): IndexedProjectSummary {
        if (!this.#activeProject) throw new Error("No indexed project is active");
        return this.#activeProject;
    }

    #handleGlobalInput(data: string): { consume?: boolean } | undefined {
        if (
            this.#activeJob &&
            !this.#modalActive &&
            !this.#cancelPromptActive &&
            this.#ui.getFocusedComponent() === this.#editor &&
            matchesKey(data, Key.escape)
        ) {
            this.#cancelPromptActive = true;
            void this.#confirm(`Cancel indexing ${basename(this.#activeJob.root)}?`, false)
                .then((cancel) => {
                    if (cancel) this.#activeJob?.controller.abort(new Error("Indexing cancelled from the TUI"));
                })
                .finally(() => {
                    this.#cancelPromptActive = false;
                });
            return { consume: true };
        }
        if (!matchesKey(data, Key.ctrl("c"))) return undefined;
        if (this.#modalActive) return undefined;
        if (this.#editor.getText()) {
            this.#editor.setText("");
            this.#ui.requestRender();
            return { consume: true };
        }
        const now = Date.now();
        if (now - this.#lastInterrupt < 1_000) {
            void this.#quit();
        } else {
            this.#lastInterrupt = now;
            this.#footer.setNotice("Press Ctrl+C again to quit");
            setTimeout(() => {
                this.#footer.setNotice();
                this.#ui.requestRender();
            }, 1_000);
            this.#ui.requestRender();
        }
        return { consume: true };
    }

    async #quit(): Promise<void> {
        if (this.#stopping) return;
        if (this.#activeJob) {
            const cancel = await this.#confirm("Cancel indexing and quit?", false);
            if (!cancel) return;
            this.#activeJob.controller.abort(new Error("Indexing cancelled while exiting the TUI"));
        }
        this.#stopping = true;
        if (this.#live?.running) {
            await this.#live.stop().catch(() => {});
        }
        await this.#livePublicationChain;
        this.#live = undefined;
        this.#stopProgress();
        this.#ui.terminal.setProgress(false);
        this.#ui.stop();
        await this.#ui.terminal.drainInput(200, 30);
        this.#resolveRun?.();
    }
}

function environmentApiKey(): string | undefined {
    return process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY;
}

function apiKeyOptions(apiKey: string | undefined): { apiKey?: string } {
    return apiKey === undefined
        ? {}
        : { apiKey };
}

function detectProjectRoot(cwd: string): string {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : cwd;
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitPatterns(value: string): readonly string[] {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function editableProfile(profile: ProviderProfile): ProviderProfileInput {
    return {
        name: profile.name,
        embedding: { ...profile.embedding },
        ...(profile.reranking === undefined
            ? {}
            : { reranking: { ...profile.reranking } }),
    };
}

function editablePreset(preset: IndexingPreset): IndexingPresetInput {
    return {
        name: preset.name,
        providerProfile: preset.providerProfile,
        ...(preset.maximumChunkSize === undefined
            ? {}
            : { maximumChunkSize: preset.maximumChunkSize }),
        ...(preset.windows1251 === undefined
            ? {}
            : { windows1251: preset.windows1251 }),
        ...(preset.include === undefined
            ? {}
            : { include: [...preset.include] }),
        ...(preset.exclude === undefined
            ? {}
            : { exclude: [...preset.exclude] }),
    };
}

function requireEditedProfile(
    value: unknown,
    expectedName: string,
): ProviderProfileInput {
    if (!isRecord(value) || value.name !== expectedName) {
        throw new Error(
            `Edited profile name must remain ${expectedName}; use Rename to update references safely`,
        );
    }
    rejectUnknownKeys(
        value,
        ["name", "embedding", "reranking"],
        "profile",
    );
    if (isRecord(value.embedding)) {
        rejectUnknownKeys(
            value.embedding,
            [
                "provider",
                "model",
                "dimensions",
                "baseUrl",
                "maximumInputs",
                "embeddingSuffix",
            ],
            "profile embedding",
        );
    }
    if (isRecord(value.reranking)) {
        rejectUnknownKeys(
            value.reranking,
            ["provider", "model", "baseUrl", "instruction"],
            "profile reranking",
        );
    }
    return value as unknown as ProviderProfileInput;
}

function requireEditedPreset(
    value: unknown,
    expectedName: string,
): IndexingPresetInput {
    if (!isRecord(value) || value.name !== expectedName) {
        throw new Error(
            `Edited preset name must remain ${expectedName}; use Rename to update references safely`,
        );
    }
    rejectUnknownKeys(
        value,
        [
            "name",
            "providerProfile",
            "maximumChunkSize",
            "windows1251",
            "include",
            "exclude",
        ],
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
        throw new Error(
            `Edited ${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
        );
    }
}

function parsePositiveInteger(value: string, label: string): number {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) {
        throw new Error(`${label} must be a positive integer`);
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}

function parseOptionalPositiveInteger(
    value: string,
    label: string,
): number | undefined {
    return value.trim().length === 0
        ? undefined
        : parsePositiveInteger(value, label);
}

function mediaTypeFor(path: string): string {
    const extension = extname(path).toLowerCase();
    return ({
        ".css": "text/css",
        ".csv": "text/csv",
        ".html": "text/html",
        ".htm": "text/html",
        ".json": "application/json",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".pdf": "application/pdf",
        ".tsv": "text/tab-separated-values",
        ".txt": "text/plain",
        ".xml": "application/xml",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
    } as Readonly<Record<string, string>>)[extension] ?? "application/octet-stream";
}
