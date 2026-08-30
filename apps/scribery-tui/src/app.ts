import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

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
    type SlashCommand,
} from "@earendil-works/pi-tui";
import {
    IndexingPresetService,
    listIndexedProjects,
    ProjectIndexingService,
    ProjectInspectionService,
    ProjectRetrievalTargetService,
    ProviderProfileRenameService,
    ProviderProfileService,
    type IndexedProjectSummary,
    type RetrievalResult,
} from "scribery";

import { commandHelp, COMMANDS } from "./commands.js";
import { FooterComponent } from "./components/footer.js";
import { HeaderComponent } from "./components/header.js";
import { PromptLabelComponent } from "./components/prompt-label.js";
import { SearchResultsComponent } from "./components/search-results.js";
import type { ProjectPreference } from "./domain/project-preferences.js";
import { ProfileController } from "./features/profile-controller.js";
import { DocumentationController } from "./features/documentation-controller.js";
import { LiveIndexingController } from "./features/live-indexing-controller.js";
import { ProjectController } from "./features/project-controller.js";
import { ProjectIndexingController } from "./features/project-indexing-controller.js";
import { PresetController } from "./features/preset-controller.js";
import { ManualOperationManager } from "./operations/manual-operation-manager.js";
import {
    ActiveIndexResolver,
    type ActiveIndexSummary,
} from "./services/active-index-resolver.js";
import { ProjectPreferenceStore } from "./services/preference-store.js";
import { formatError } from "./services/error-formatter.js";
import { editJsonConfiguration } from "./services/json-config-editor.js";
import {
    SystemProfileCredentialStore,
    type ProfileCredentialStore,
} from "./services/profile-credential-store.js";
import { apiKeyOptions, ProviderAccess } from "./services/provider-access.js";
import { projectForDirectory } from "./services/project-context.js";
import { colors, editorTheme } from "./theme.js";
import { DialogHost } from "./ui/dialog-host.js";
import { ProgressPresenter } from "./ui/progress-presenter.js";

export interface ScriberyTuiAppOptions {
    cwd?: string;
    preferences?: ProjectPreferenceStore;
    credentials?: ProfileCredentialStore;
}

export class ScriberyTuiApp {
    readonly #cwd: string;
    readonly #preferences: ProjectPreferenceStore;
    readonly #credentials: ProfileCredentialStore;
    readonly #providerAccess: ProviderAccess;
    readonly #profiles: ProviderProfileService;
    readonly #profileRenames = new ProviderProfileRenameService();
    readonly #presets = new IndexingPresetService();
    readonly #indexing: ProjectIndexingService;
    readonly #inspection = new ProjectInspectionService();
    readonly #targets = new ProjectRetrievalTargetService();
    readonly #activeIndexes = new ActiveIndexResolver(this.#targets);
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
    readonly #dialogs = new DialogHost(this.#ui, this.#editor, this.#editorArea);
    readonly #progressPresenter = new ProgressPresenter(
        this.#ui,
        this.#progressArea,
        () => this.#terminalSuspended,
    );
    readonly #operations = new ManualOperationManager(
        this.#progressPresenter,
        () => this.#updateHeader(),
    );
    readonly #profileController: ProfileController;
    readonly #presetController: PresetController;
    readonly #documentations: DocumentationController;
    readonly #liveIndexing: LiveIndexingController;
    readonly #projectIndexing: ProjectIndexingController;
    readonly #projectController: ProjectController;
    #projects: readonly IndexedProjectSummary[] = [];
    #activeProject: IndexedProjectSummary | undefined;
    #activePreference: ProjectPreference | undefined;
    #activeIndex: ActiveIndexSummary | undefined;
    #lastInterrupt = 0;
    #stopping = false;
    #cancelPromptActive = false;
    #terminalSuspended = false;
    #resolveRun?: () => void;

    constructor(options: ScriberyTuiAppOptions = {}) {
        this.#cwd = resolve(options.cwd ?? process.cwd());
        this.#preferences = options.preferences ?? new ProjectPreferenceStore();
        this.#credentials = options.credentials ?? new SystemProfileCredentialStore();
        this.#providerAccess = new ProviderAccess(this.#credentials);
        this.#profiles = new ProviderProfileService(
            apiKeyOptions(this.#providerAccess.environmentApiKey),
        );
        this.#indexing = new ProjectIndexingService(
            apiKeyOptions(this.#providerAccess.environmentApiKey),
        );
        this.#profileController = new ProfileController({
            ui: {
                append: (message, tone) => this.#append(message, tone),
                pick: (title, items) => this.#dialogs.pick(title, items),
                input: (title, label, initialValue) =>
                    this.#dialogs.input(title, label, initialValue),
                secretInput: (title, label) => this.#dialogs.secretInput(title, label),
                confirm: (title, defaultYes) => this.#dialogs.confirm(title, defaultYes),
                editJson: (value, label) => this.#editConfigurationJson(value, label),
            },
            project: {
                activeProject: () => this.#activeProject,
                activePreference: () => this.#activePreference,
                setActivePreference: (preference) => {
                    this.#activePreference = preference;
                    this.#updateHeader();
                },
                reloadActivePreference: async () => {
                    this.#activePreference = this.#activeProject
                        ? await this.#preferences.get(this.#activeProject.projectIdentifier)
                        : undefined;
                    this.#updateHeader();
                },
            },
            preferences: this.#preferences,
            providerAccess: this.#providerAccess,
            profiles: this.#profiles,
            profileRenames: this.#profileRenames,
            liveRunning: () => this.#liveIndexing.running,
        });
        this.#presetController = new PresetController({
            ui: {
                append: (message, tone) => this.#append(message, tone),
                pick: (title, items) => this.#dialogs.pick(title, items),
                input: (title, label, initialValue) =>
                    this.#dialogs.input(title, label, initialValue),
                secretInput: (title, label) => this.#dialogs.secretInput(title, label),
                confirm: (title, defaultYes) => this.#dialogs.confirm(title, defaultYes),
                editJson: (value, label) => this.#editConfigurationJson(value, label),
            },
            project: {
                activeProject: () => this.#activeProject,
                activePreference: () => this.#activePreference,
                setActivePreference: (preference) => {
                    this.#activePreference = preference;
                    this.#updateHeader();
                },
                reloadActivePreference: async () => {
                    this.#activePreference = this.#activeProject
                        ? await this.#preferences.get(this.#activeProject.projectIdentifier)
                        : undefined;
                    this.#updateHeader();
                },
            },
            preferences: this.#preferences,
            profiles: this.#profiles,
            presets: this.#presets,
            pickProfile: (profiles, title, currentName) =>
                this.#profileController.pickProfile(profiles, title, currentName),
            liveRunning: () => this.#liveIndexing.running,
        });
        this.#documentations = new DocumentationController({
            cwd: this.#cwd,
            ui: {
                append: (message, tone) => this.#append(message, tone),
                appendError: (error) => this.#appendError(error),
                pick: (title, items) => this.#dialogs.pick(title, items),
                input: (title, label, initialValue) =>
                    this.#dialogs.input(title, label, initialValue),
                confirm: (title, defaultYes) => this.#dialogs.confirm(title, defaultYes),
                showSearchResults: (query, results) => {
                    const component = new SearchResultsComponent({
                        query,
                        results,
                        requestRender: () => this.#ui.requestRender(),
                        onDone: () => this.#ui.setFocus(this.#editor),
                    });
                    this.#transcript.addChild(component);
                    this.#transcript.addChild(new Spacer(1));
                    if (results.length > 0) this.#ui.setFocus(component);
                    this.#ui.requestRender(true);
                },
                requestRender: () => this.#ui.requestRender(),
            },
            operations: this.#operations,
            providerAccess: this.#providerAccess,
            profiles: this.#profiles,
            presets: () => this.#presets.list(),
            pickPreset: (presets, title) => this.#presetController.pick(presets, title),
            activePreference: () => this.#activePreference,
            searchProfile: () => this.#searchProfile(),
            liveRunning: () => this.#liveIndexing.running,
        });
        this.#liveIndexing = new LiveIndexingController({
            ui: {
                append: (message, tone) => this.#append(message, tone),
                appendError: (error) => this.#appendError(error),
                pick: (title, items) => this.#dialogs.pick(title, items),
                updateHeader: () => this.#updateHeader(),
            },
            operations: this.#operations,
            progress: this.#progressPresenter,
            preferences: this.#preferences,
            providerAccess: this.#providerAccess,
            profiles: this.#profiles,
            presets: this.#presets,
            profileController: this.#profileController,
            pickPreset: (presets, title) => this.#presetController.pick(presets, title),
            activeProject: () => this.#activeProject,
            activePreference: () => this.#activePreference,
            refreshProjects: (projectIdentifier) => this.#refreshProjects(projectIdentifier),
            terminalSuspended: () => this.#terminalSuspended,
        });
        this.#projectIndexing = new ProjectIndexingController({
            cwd: this.#cwd,
            ui: {
                append: (message, tone) => this.#append(message, tone),
                appendError: (error) => this.#appendError(error),
                pick: (title, items) => this.#dialogs.pick(title, items),
                input: (title, label, initialValue) =>
                    this.#dialogs.input(title, label, initialValue),
                requestRender: () => this.#ui.requestRender(),
            },
            operations: this.#operations,
            providerAccess: this.#providerAccess,
            preferences: this.#preferences,
            profiles: this.#profiles,
            presets: this.#presets,
            profileController: this.#profileController,
            pickPreset: (presets, title) => this.#presetController.pick(presets, title),
            activeProject: () => this.#activeProject,
            activePreference: () => this.#activePreference,
            liveRunning: () => this.#liveIndexing.running,
            refreshProjects: (projectIdentifier) => this.#refreshProjects(projectIdentifier),
        });
        this.#projectController = new ProjectController({
            cwd: this.#cwd,
            ui: {
                append: (message, tone) => this.#append(message, tone),
                pick: (title, items) => this.#dialogs.pick(title, items),
                pickWithDelete: (title, items) =>
                    this.#dialogs.pickWithDelete(title, items),
                input: (title, label, initialValue) =>
                    this.#dialogs.input(title, label, initialValue),
                confirm: (title, defaultYes) => this.#dialogs.confirm(title, defaultYes),
                copy: (value) => this.#ui.terminal.write(
                    `\u001b]52;c;${Buffer.from(value).toString("base64")}\u0007`,
                ),
            },
            preferences: this.#preferences,
            inspection: this.#inspection,
            targets: this.#targets,
            projects: () => this.#projects,
            activeProject: () => this.#activeProject,
            activePreference: () => this.#activePreference,
            refreshProjects: (projectIdentifier) => this.#refreshProjects(projectIdentifier),
            clearActiveProject: () => {
                this.#activeProject = undefined;
                this.#activePreference = undefined;
            },
            liveRunning: () => this.#liveIndexing.running,
        });
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
            case "index": await this.#projectIndexing.configureAndStart(); break;
            case "live": await this.#liveIndexing.manage(argument); break;
            case "project": await this.#projectController.select(argument); break;
            case "search": await this.#promptSearch(); break;
            case "profile": await this.#profileController.manageProfiles(argument); break;
            case "preset": await this.#presetController.manage(argument); break;
            case "builds": await this.#projectController.browseBuilds(); break;
            case "target": await this.#projectController.manageTargets(); break;
            case "chunks": await this.#projectController.inspectChunks(argument); break;
            case "documentation": await this.#documentations.manage(); break;
            case "jobs": this.#showJobs(); break;
            case "mcp": await this.#projectController.showMcp(); break;
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
            const searchService = await this.#providerAccess.searchService(profile);
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



    #showJobs(): void {
        if (this.#liveIndexing.running && this.#liveIndexing.status !== undefined) {
            const status = this.#liveIndexing.status;
            this.#append([
                `Live indexing ${status.root}`,
                `Phase: ${status.phase} · generation ${status.generation}`,
                `Branch: ${status.branch ?? "unknown"} · target ${status.target ?? "pending"}`,
                `Updated: ${relativeTime(status.updatedAt)}`,
            ].join("\n"));
            return;
        }
        const operation = this.#operations.active;
        if (!operation) {
            this.#append("No indexing operation is running.", "muted");
            return;
        }
        const progress = operation.progress;
        this.#append([
            `Indexing ${operation.root}`,
            `Elapsed: ${formatDuration(Date.now() - operation.startedAt)}`,
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
        if (this.#operations.running) {
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
            this.#liveIndexing.restorePresentation();
            this.#ui.requestRender(true);
        }
        if (failure !== undefined) this.#appendError(failure);
    }

    async #doctor(): Promise<void> {
        const profiles = await this.#profiles.list();
        const selected = this.#activePreference?.profile ?? await this.#profileController.pickProfile(profiles, "Select profile to test");
        if (!selected) return;
        await this.#profileController.diagnoseProfile(selected);
    }

    async #showSettings(): Promise<void> {
        const credentialStatus = await this.#providerAccess.credentialsAvailable()
            ? `${this.#providerAccess.credentialDisplayName} is available for secure, persistent per-profile keys.`
            : `${this.#providerAccess.credentialDisplayName} is unavailable; session and environment keys still work.`;
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
            `API keys can be saved per profile in ${this.#providerAccess.credentialDisplayName} or kept only for this session.`,
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
        this.#activeIndex = this.#activeProject
            ? await this.#activeIndexes.resolve(this.#activeProject)
            : undefined;
        this.#updateHeader();
    }

    #updateHeader(): void {
        this.#header.setState({
            ...(this.#activeProject === undefined ? {} : { project: this.#activeProject }),
            ...(this.#activePreference === undefined ? {} : { preference: this.#activePreference }),
            ...(this.#activeIndex === undefined ? {} : { activeIndex: this.#activeIndex }),
            indexing: this.#operations.running,
            ...(this.#liveIndexing.status === undefined ? {} : { live: this.#liveIndexing.status }),
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

    async #input(title: string, label: string, initialValue?: string): Promise<string | undefined> {
        return this.#dialogs.input(title, label, initialValue);
    }


    async #editConfigurationJson(
        value: unknown,
        label: string,
    ): Promise<unknown | undefined> {
        if (this.#operations.running || this.#liveIndexing.running) {
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
        return this.#dialogs.confirm(title, defaultYes);
    }


    #handleGlobalInput(data: string): { consume?: boolean } | undefined {
        if (
            this.#operations.active &&
            !this.#dialogs.active &&
            !this.#cancelPromptActive &&
            this.#ui.getFocusedComponent() === this.#editor &&
            matchesKey(data, Key.escape)
        ) {
            this.#cancelPromptActive = true;
            void this.#confirm(`Cancel indexing ${basename(this.#operations.active.root)}?`, false)
                .then((cancel) => {
                    if (cancel) this.#operations.abort(new Error("Indexing cancelled from the TUI"));
                })
                .finally(() => {
                    this.#cancelPromptActive = false;
                });
            return { consume: true };
        }
        if (!matchesKey(data, Key.ctrl("c"))) return undefined;
        if (this.#dialogs.active) return undefined;
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
        if (this.#operations.running) {
            const cancel = await this.#confirm("Cancel indexing and quit?", false);
            if (!cancel) return;
            this.#operations.abort(new Error("Indexing cancelled while exiting the TUI"));
        }
        this.#stopping = true;
        if (this.#liveIndexing.running) {
            await this.#liveIndexing.stop(false).catch(() => {});
        }
        this.#progressPresenter.stop();
        this.#ui.stop();
        await this.#ui.terminal.drainInput(200, 30);
        this.#resolveRun?.();
    }
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
