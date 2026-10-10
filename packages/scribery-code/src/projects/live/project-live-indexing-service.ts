import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

import { hashText, serializeError, type PreparedSourceSnapshot } from "scribery-core";
import { inspectSourceState, type SourceState, type WorkingTreeState } from "../../source-control/index.js";
import { GitWorkingTreeSourceProvider } from "../../sources/index.js";
import type { ProjectLiveIndexingReason, ProjectLiveIndexingRequest, ProjectLiveIndexingStatus } from "../contracts/live-indexing.js";
import type { ProjectIndexingOutcome, ProjectIndexingRequest } from "../contracts/project-indexing.js";
import { ProjectIndexingService } from "../indexing/project-indexing-service.js";
import type { IndexedProjectSummary } from "../managed/list-projects.js";
import { managedIndexesDirectory } from "../managed/paths.js";
import { ProjectRetrievalTargetService } from "../retrieval/retrieval-target-service.js";
import { DEFAULT_LIVE_CACHE_BUILD_LIMIT, ProjectLiveBuildCache } from "./live-build-cache.js";
import { LIVE_INDEXING_STALE_AFTER_MILLISECONDS, ProjectLiveIndexingStateCatalog } from "./live-state-catalog.js";
import { LIVE_CURRENT_TARGET, liveBranchTarget } from "./live-target.js";

interface LiveWatcher { close(): void; }
type GitSource = Extract<SourceState, { kind: "git" }>;

export interface ProjectLiveIndexingServiceOptions {
    indexesDirectory?: string;
    profilesPath?: string;
    apiKey?: string | undefined;
    fetch?: typeof globalThis.fetch;
    inspectSource?: (root: string) => Promise<SourceState>;
    prepareSource?: (request: ProjectLiveIndexingRequest, source: GitSource, signal: AbortSignal) => Promise<PreparedSourceSnapshot>;
    index?: (request: ProjectIndexingRequest) => Promise<ProjectIndexingOutcome>;
    resolveProject?: (reference: string | undefined, currentDirectory: string) => Promise<IndexedProjectSummary>;
    assignTarget?: (projectReference: string, target: string, indexBuildId: string, activate: boolean, keepReplacedBuilds?: number, sessionId?: string) => Promise<Readonly<Record<string, unknown>>>;
    watchRoot?: (root: string, onChange: (path?: string) => void, onError: (error: Error) => void) => LiveWatcher;
}

export class ProjectLiveIndexingService {
    readonly #inspectSource: NonNullable<ProjectLiveIndexingServiceOptions["inspectSource"]>;
    readonly #prepareSource: NonNullable<ProjectLiveIndexingServiceOptions["prepareSource"]>;
    readonly #index: NonNullable<ProjectLiveIndexingServiceOptions["index"]>;
    readonly #resolveProject: NonNullable<ProjectLiveIndexingServiceOptions["resolveProject"]>;
    readonly #assignTarget: NonNullable<ProjectLiveIndexingServiceOptions["assignTarget"]>;
    readonly #watchRoot: NonNullable<ProjectLiveIndexingServiceOptions["watchRoot"]>;
    readonly #targets: ProjectRetrievalTargetService;
    readonly #states: ProjectLiveIndexingStateCatalog;
    readonly #cache: ProjectLiveBuildCache;
    #request: ProjectLiveIndexingRequest | undefined;
    #project: IndexedProjectSummary | undefined;
    #status: ProjectLiveIndexingStatus | undefined;
    #watcher: LiveWatcher | undefined;
    #pollTimer: NodeJS.Timeout | undefined;
    #scheduleTimer: NodeJS.Timeout | undefined;
    #reconciliation: Promise<void> | undefined;
    #polling: Promise<void> | undefined;
    #stopping: Promise<ProjectLiveIndexingStatus | undefined> | undefined;
    #indexController: AbortController | undefined;
    #writeChain: Promise<void> = Promise.resolve();
    #idleWaiters: Array<() => void> = [];
    #generation = 0;
    #running = false;
    #diagnosedProvider = false;
    #lastGitFingerprint: string | undefined;
    #publishedFingerprint: string | undefined;
    #lastBuildStartedAt = -Infinity;
    #firstChangeAt: number | undefined;
    #lastChangeAt: number | undefined;
    #pendingReason: ProjectLiveIndexingReason | undefined;
    #force = false;
    #immediate = false;

    constructor(options: ProjectLiveIndexingServiceOptions = {}) {
        const indexesDirectory = options.indexesDirectory ?? managedIndexesDirectory();
        const indexing = new ProjectIndexingService({
            indexesDirectory,
            ...(options.profilesPath === undefined ? {} : { profilesPath: options.profilesPath }),
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        this.#targets = new ProjectRetrievalTargetService({ indexesDirectory });
        const workingTree = new GitWorkingTreeSourceProvider();
        this.#inspectSource = options.inspectSource ?? inspectSourceState;
        this.#prepareSource = options.prepareSource ?? ((request, source, signal) => workingTree.prepare({
            context: source.context,
            state: source.state,
            signal,
            discoveryOptions: {
                ...(request.include === undefined ? {} : { include: request.include }),
                ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
            },
        }));
        this.#index = options.index ?? ((request) => indexing.index(request));
        this.#resolveProject = options.resolveProject ?? ((reference, cwd) => this.#targets.resolveProject(reference, cwd));
        this.#assignTarget = options.assignTarget ?? ((reference, _target, buildId, _activate, _keep, sessionId) =>
            this.#targets.assignLiveTarget(reference, buildId, sessionId!));
        this.#watchRoot = options.watchRoot ?? watchProjectRoot;
        this.#states = new ProjectLiveIndexingStateCatalog(indexesDirectory);
        this.#cache = new ProjectLiveBuildCache(indexesDirectory);
    }

    get running(): boolean { return this.#running || this.#stopping !== undefined; }
    get status(): ProjectLiveIndexingStatus | undefined { return this.#status; }

    async start(request: ProjectLiveIndexingRequest): Promise<ProjectLiveIndexingStatus> {
        if (this.running) throw new Error("Live indexing is already running");
        validateRequest(request);
        const root = resolve(request.root);
        const project = await this.#resolveProject(request.projectReference, root);
        if (project.root === undefined || resolve(project.root) !== root) {
            throw new Error("Live indexing requires an existing managed project at the selected root");
        }
        const source = await this.#inspectSource(root);
        if (source.kind !== "git") throw new Error("Live indexing requires a Git worktree");
        const existing = await this.#states.read(project.projectIdentifier);
        if (existing !== undefined && existing.phase !== "stopped" &&
            Date.now() - Date.parse(existing.updatedAt) <= LIVE_INDEXING_STALE_AFTER_MILLISECONDS) {
            throw new Error(`Live indexing is already active for ${project.root}`);
        }
        const previousSelection = await this.#targets.previousSelection(project);
        this.#request = { ...request, root };
        this.#project = project;
        this.#running = true;
        this.#generation = 1;
        this.#diagnosedProvider = false;
        this.#publishedFingerprint = undefined;
        this.#lastBuildStartedAt = -Infinity;
        this.#lastGitFingerprint = gitFingerprint(source.state);
        const now = new Date().toISOString();
        try {
            await this.#publishStatus({
                schemaVersion: 1, sessionId: randomUUID(), processId: process.pid,
                projectIdentifier: project.projectIdentifier, root,
                phase: "pending", generation: this.#generation,
                startedAt: now, updatedAt: now, reason: "initial",
                branch: liveBranchTarget(source.state).branch, target: LIVE_CURRENT_TARGET,
                previousSelection, cacheBuildLimit: request.cacheBuildLimit ?? DEFAULT_LIVE_CACHE_BUILD_LIMIT,
            });
            this.#watcher = this.#watchRoot(root, (path) => {
                if (isRelevantWatchPath(path)) this.#requestReconciliation("filesystem");
            }, (error) => { void this.#publishFailure(new Error("Live filesystem watcher failed; retrieval is paused", { cause: error })); });
            this.#pollTimer = setInterval(() => { void this.#poll(); }, request.pollIntervalMilliseconds ?? 2_000);
            this.#pendingReason = "initial";
            this.#immediate = true;
            this.#schedule();
            await this.#waitForIdle();
            return this.#requiredStatus();
        } catch (error: unknown) {
            if (this.#running) await this.#publishFailure(error);
            await this.stop();
            throw error;
        }
    }

    async reconcile(): Promise<ProjectLiveIndexingStatus> {
        if (!this.#running) throw new Error("Live indexing is not running");
        this.#force = true;
        this.#requestReconciliation("manual", true);
        await this.#waitForIdle();
        return this.#requiredStatus();
    }

    async stop(): Promise<ProjectLiveIndexingStatus | undefined> {
        if (this.#stopping !== undefined) return this.#stopping;
        if (!this.#running) return this.#status;
        this.#stopping = this.#stopSession().finally(() => {
            this.#stopping = undefined;
            this.#notifyIdle();
        });
        return this.#stopping;
    }

    async #stopSession(): Promise<ProjectLiveIndexingStatus | undefined> {
        this.#running = false;
        if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
        if (this.#scheduleTimer !== undefined) clearTimeout(this.#scheduleTimer);
        this.#pollTimer = undefined;
        this.#scheduleTimer = undefined;
        this.#watcher?.close();
        this.#watcher = undefined;
        this.#indexController?.abort(new Error("Live indexing stopped"));
        await this.#reconciliation;
        await this.#polling;
        this.#pendingReason = undefined;
        this.#firstChangeAt = undefined;
        this.#lastChangeAt = undefined;
        this.#force = false;
        this.#immediate = false;
        const current = this.#requiredStatus();
        try {
            await this.#targets.releaseLiveTarget(current.projectIdentifier, current.sessionId, current.previousSelection ?? { type: "none" });
            await this.#publishStatus({ ...current, phase: "stopped", updatedAt: new Date().toISOString() });
            await this.#cache.prune(this.#requiredProject(), current.cacheBuildLimit ?? DEFAULT_LIVE_CACHE_BUILD_LIMIT);
        } finally {
            this.#notifyIdle();
        }
        return this.#status;
    }

    #requestReconciliation(reason: ProjectLiveIndexingReason, immediate = false): void {
        if (!this.#running) return;
        this.#generation += 1;
        const now = Date.now();
        this.#firstChangeAt ??= now;
        this.#lastChangeAt = now;
        this.#pendingReason = reason;
        this.#immediate ||= immediate;
        this.#schedule();
    }

    #schedule(): void {
        if (!this.#running || this.#reconciliation !== undefined || this.#pendingReason === undefined) return;
        if (this.#scheduleTimer !== undefined) clearTimeout(this.#scheduleTimer);
        const request = this.#requiredRequest();
        const now = Date.now();
        const quietAt = (this.#lastChangeAt ?? now) + (request.debounceMilliseconds ?? 750);
        const deadline = (this.#firstChangeAt ?? now) + (request.maximumWaitMilliseconds ?? 5_000);
        const checkAt = this.#immediate ? now : Math.min(quietAt, deadline);
        const due = Math.max(checkAt, this.#lastBuildStartedAt + (request.minimumBuildIntervalMilliseconds ?? 5_000));
        this.#scheduleTimer = setTimeout(() => {
            this.#scheduleTimer = undefined;
            const reason = this.#pendingReason!;
            const force = this.#force;
            this.#pendingReason = undefined;
            this.#firstChangeAt = undefined;
            this.#lastChangeAt = undefined;
            this.#force = false;
            this.#immediate = false;
            this.#reconciliation = this.#reconcileOnce(reason, force)
                .catch(async (error: unknown) => { if (this.#running) await this.#publishFailure(error); })
                .finally(() => {
                    this.#reconciliation = undefined;
                    this.#schedule();
                    this.#notifyIdle();
                });
        }, Math.max(0, due - now));
    }

    async #reconcileOnce(reason: ProjectLiveIndexingReason, force: boolean): Promise<void> {
        const controller = new AbortController();
        this.#indexController = controller;
        try {
            const { source, snapshot, fingerprint } = await this.#snapshot(controller.signal);
            if (!this.#running) return;
            const branch = liveBranchTarget(source.state).branch;
            this.#lastGitFingerprint = gitFingerprint(source.state);
            if (!force && this.#status?.phase === "ready" && fingerprint === this.#publishedFingerprint) return;
            await this.#phase("pending", reason, branch);
            await this.#phase("indexing", reason, branch);
            this.#lastBuildStartedAt = Date.now();
            const outcome = await this.#index(this.#indexRequest(controller.signal, snapshot));
            await this.#cache.record(this.#requiredProject().projectIdentifier, outcome.result.indexBuildId, outcome.result.reused === true);
            this.#diagnosedProvider = true;
            if (!this.#running) return;
            const latest = await this.#snapshot(controller.signal);
            if (latest.fingerprint !== fingerprint) {
                await this.#superseded(reason, latest.source.state);
                await this.#pruneCache();
                return;
            }
            await this.#assignTarget(this.#requiredProject().projectIdentifier, LIVE_CURRENT_TARGET,
                outcome.result.indexBuildId, true, undefined, this.#requiredStatus().sessionId);
            if (!this.#running) return;
            const afterPublication = await this.#snapshot(controller.signal);
            if (afterPublication.fingerprint !== fingerprint) {
                await this.#superseded(reason, afterPublication.source.state);
                await this.#pruneCache();
                return;
            }
            this.#publishedFingerprint = fingerprint;
            this.#lastGitFingerprint = gitFingerprint(afterPublication.source.state);
            const { reason: _reason, error: _error, ...current } = this.#requiredStatus();
            await this.#publishStatus({
                ...current, phase: "ready", generation: this.#generation,
                branch, target: LIVE_CURRENT_TARGET, indexBuildId: outcome.result.indexBuildId,
                updatedAt: new Date().toISOString(),
            });
            await this.#pruneCache();
        } finally {
            this.#indexController = undefined;
        }
    }

    async #snapshot(signal: AbortSignal): Promise<{ source: GitSource; snapshot: PreparedSourceSnapshot; fingerprint: string }> {
        const request = this.#requiredRequest();
        const source = await this.#inspectSource(request.root);
        if (source.kind !== "git") throw new Error("The live indexing root is no longer a Git worktree");
        const snapshot = await this.#prepareSource(request, source, signal);
        return { source, snapshot, fingerprint: snapshotFingerprint(snapshot, source.state) };
    }

    async #superseded(reason: ProjectLiveIndexingReason, state: WorkingTreeState): Promise<void> {
        if (!this.#running) return;
        await this.#phase("pending", reason, liveBranchTarget(state).branch);
        this.#requestReconciliation(reason === "manual" || reason === "initial" ? "filesystem" : reason);
    }

    #pruneCache(): Promise<void> {
        return this.#cache.prune(this.#requiredProject(), this.#requiredRequest().cacheBuildLimit ?? DEFAULT_LIVE_CACHE_BUILD_LIMIT);
    }

    #indexRequest(signal: AbortSignal, preparedSource: PreparedSourceSnapshot): ProjectIndexingRequest {
        const request = this.#requiredRequest();
        return {
            root: request.root, provider: request.provider, preparedSource,
            keepReplacedBuilds: request.keepReplacedBuilds ?? 1,
            allowDirty: true, diagnoseProvider: !this.#diagnosedProvider, persistRecipe: false, signal,
            onEvent: (event) => request.onEvent?.({ type: "indexing", event }),
            ...(request.maximumChunkSize === undefined ? {} : { maximumChunkSize: request.maximumChunkSize }),
            ...(request.windows1251 === undefined ? {} : { windows1251: request.windows1251 }),
            ...(request.include === undefined ? {} : { include: request.include }),
            ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
        };
    }

    async #poll(): Promise<void> {
        if (!this.#running || this.#polling !== undefined) return;
        this.#polling = (async () => {
            try {
                const source = await this.#inspectSource(this.#requiredRequest().root);
                if (!this.#running) return;
                if (source.kind !== "git") throw new Error("The live indexing root is no longer a Git worktree");
                const fingerprint = gitFingerprint(source.state);
                if (fingerprint !== this.#lastGitFingerprint) {
                    this.#lastGitFingerprint = fingerprint;
                    this.#requestReconciliation("git");
                }
                const current = this.#requiredStatus();
                await this.#publishStatus({ ...current, updatedAt: new Date().toISOString() }, false);
            } catch (error: unknown) {
                if (this.#running) await this.#publishFailure(error);
            }
        })().finally(() => { this.#polling = undefined; });
        await this.#polling;
    }

    async #phase(phase: "pending" | "indexing", reason: ProjectLiveIndexingReason, branch: string): Promise<void> {
        const { error: _error, ...current } = this.#requiredStatus();
        await this.#publishStatus({ ...current, phase, reason, branch, generation: this.#generation, updatedAt: new Date().toISOString() });
    }

    async #publishFailure(error: unknown): Promise<void> {
        if (!this.#running) return;
        await this.#publishStatus({ ...this.#requiredStatus(), phase: "failed", generation: this.#generation, updatedAt: new Date().toISOString(), error: serializeError(error) });
    }

    async #publishStatus(status: ProjectLiveIndexingStatus, emit = true): Promise<void> {
        this.#status = status;
        if (emit) this.#request?.onEvent?.({ type: "status", status });
        this.#writeChain = this.#writeChain.catch(() => {}).then(() => this.#states.write(status));
        await this.#writeChain;
    }

    #waitForIdle(): Promise<void> {
        if (this.#reconciliation === undefined && this.#scheduleTimer === undefined && this.#pendingReason === undefined) return Promise.resolve();
        return new Promise((resolve) => { this.#idleWaiters.push(resolve); });
    }

    #notifyIdle(): void {
        if (this.#stopping !== undefined || this.#reconciliation !== undefined || this.#scheduleTimer !== undefined || this.#pendingReason !== undefined) return;
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }

    #requiredRequest(): ProjectLiveIndexingRequest {
        if (this.#request === undefined) throw new Error("Live indexing is not configured");
        return this.#request;
    }
    #requiredProject(): IndexedProjectSummary {
        if (this.#project === undefined) throw new Error("Live indexing project is unavailable");
        return this.#project;
    }
    #requiredStatus(): ProjectLiveIndexingStatus {
        if (this.#status === undefined) throw new Error("Live indexing status is unavailable");
        return this.#status;
    }
}

function validateRequest(request: ProjectLiveIndexingRequest): void {
    for (const [label, value] of [
        ["Live indexing debounce", request.debounceMilliseconds],
        ["Live indexing poll interval", request.pollIntervalMilliseconds],
        ["Live indexing maximum wait", request.maximumWaitMilliseconds],
        ["Live indexing minimum build interval", request.minimumBuildIntervalMilliseconds],
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${label} must be a positive integer`);
    }
    for (const value of [request.keepReplacedBuilds, request.cacheBuildLimit]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Live indexing retention must be a non-negative integer");
    }
}

function gitFingerprint(state: WorkingTreeState): string {
    return JSON.stringify({ headCommit: state.headCommit ?? null, refName: state.refName ?? null, detached: state.detached, unborn: state.unborn, dirty: state.dirty, changes: state.changes });
}

function snapshotFingerprint(snapshot: PreparedSourceSnapshot, state: WorkingTreeState): string {
    return hashText(JSON.stringify({
        scopeId: snapshot.scopeId, sourceIdentity: snapshot.sourceIdentity, selection: snapshot.sourceSelectionHash,
        headCommit: state.headCommit ?? null, branch: liveBranchTarget(state).branch,
        documents: snapshot.documents.map(({ path, byteContentHash }) => [path, byteContentHash])
            .sort(([left], [right]) => left!.localeCompare(right!)),
    }));
}

function watchProjectRoot(root: string, onChange: (path?: string) => void, onError: (error: Error) => void): LiveWatcher {
    const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => onChange(filename === null ? undefined : filename.toString()));
    watcher.on("error", onError);
    return watcher;
}

function isRelevantWatchPath(path?: string): boolean {
    if (path === undefined) return true;
    const segments = path.replaceAll("\\", "/").split("/");
    return !segments.includes(".git") && !segments.includes("node_modules");
}
