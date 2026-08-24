import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

import { serializeError } from "scribery-core";
import {
    inspectSourceState,
    type SourceState,
    type WorkingTreeState,
} from "../../source-control/index.js";
import type {
    ProjectLiveIndexingEvent,
    ProjectLiveIndexingReason,
    ProjectLiveIndexingRequest,
    ProjectLiveIndexingStatus,
} from "../contracts/live-indexing.js";
import type {
    ProjectIndexingOutcome,
    ProjectIndexingRequest,
} from "../contracts/project-indexing.js";
import { ProjectIndexingService } from "../indexing/project-indexing-service.js";
import type { IndexedProjectSummary } from "../managed/list-projects.js";
import { managedIndexesDirectory } from "../managed/paths.js";
import { ProjectRetrievalTargetService } from "../retrieval/retrieval-target-service.js";
import {
    LIVE_INDEXING_STALE_AFTER_MILLISECONDS,
    ProjectLiveIndexingStateCatalog,
} from "./live-state-catalog.js";
import { liveBranchTarget } from "./live-target.js";

interface LiveWatcher {
    close(): void;
}

export interface ProjectLiveIndexingServiceOptions {
    indexesDirectory?: string;
    profilesPath?: string;
    apiKey?: string | undefined;
    fetch?: typeof globalThis.fetch;
    inspectSource?: (root: string) => Promise<SourceState>;
    index?: (request: ProjectIndexingRequest) => Promise<ProjectIndexingOutcome>;
    resolveProject?: (
        reference: string | undefined,
        currentDirectory: string,
    ) => Promise<IndexedProjectSummary>;
    assignTarget?: (
        projectReference: string,
        target: string,
        indexBuildId: string,
        activate: boolean,
        keepReplacedBuilds?: number,
    ) => Promise<Readonly<Record<string, unknown>>>;
    watchRoot?: (
        root: string,
        onChange: (path?: string) => void,
        onError: (error: Error) => void,
    ) => LiveWatcher;
}

export class ProjectLiveIndexingService {
    readonly #inspectSource: (root: string) => Promise<SourceState>;
    readonly #index: (
        request: ProjectIndexingRequest,
    ) => Promise<ProjectIndexingOutcome>;
    readonly #resolveProject: NonNullable<
        ProjectLiveIndexingServiceOptions["resolveProject"]
    >;
    readonly #assignTarget: NonNullable<
        ProjectLiveIndexingServiceOptions["assignTarget"]
    >;
    readonly #watchRoot: NonNullable<
        ProjectLiveIndexingServiceOptions["watchRoot"]
    >;
    readonly #states: ProjectLiveIndexingStateCatalog;
    #request: ProjectLiveIndexingRequest | undefined;
    #project: IndexedProjectSummary | undefined;
    #status: ProjectLiveIndexingStatus | undefined;
    #watcher: LiveWatcher | undefined;
    #pollTimer: NodeJS.Timeout | undefined;
    #debounceTimer: NodeJS.Timeout | undefined;
    #reconciliation: Promise<void> | undefined;
    #indexController: AbortController | undefined;
    #writeChain: Promise<void> = Promise.resolve();
    #generation = 0;
    #running = false;
    #diagnosedProvider = false;
    #lastGitFingerprint: string | undefined;
    #polling = false;

    constructor(options: ProjectLiveIndexingServiceOptions = {}) {
        const indexesDirectory = options.indexesDirectory ??
            managedIndexesDirectory();
        const indexing = new ProjectIndexingService({
            indexesDirectory,
            ...(options.profilesPath === undefined
                ? {}
                : { profilesPath: options.profilesPath }),
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        const targets = new ProjectRetrievalTargetService({ indexesDirectory });
        this.#inspectSource = options.inspectSource ?? inspectSourceState;
        this.#index = options.index ?? ((request) => indexing.index(request));
        this.#resolveProject = options.resolveProject ?? ((reference, cwd) =>
            targets.resolveProject(reference, cwd));
        this.#assignTarget = options.assignTarget ?? ((...arguments_) =>
            targets.assignTarget(...arguments_));
        this.#watchRoot = options.watchRoot ?? watchProjectRoot;
        this.#states = new ProjectLiveIndexingStateCatalog(indexesDirectory);
    }

    get running(): boolean {
        return this.#running;
    }

    get status(): ProjectLiveIndexingStatus | undefined {
        return this.#status;
    }

    async start(
        request: ProjectLiveIndexingRequest,
    ): Promise<ProjectLiveIndexingStatus> {
        if (this.#running) {
            throw new Error("Live indexing is already running");
        }
        validateRequest(request);
        const root = resolve(request.root);
        const project = await this.#resolveProject(
            request.projectReference,
            root,
        );
        if (project.root === undefined || resolve(project.root) !== root) {
            throw new Error(
                "Live indexing requires an existing managed project at the selected root",
            );
        }
        const source = await this.#inspectSource(root);
        if (source.kind !== "git") {
            throw new Error("Branch-aware live indexing requires a Git worktree");
        }
        const existing = await this.#states.read(project.projectIdentifier);
        if (isActiveSession(existing)) {
            throw new Error(
                `Live indexing is already active for ${project.root}`,
            );
        }

        this.#request = { ...request, root };
        this.#project = project;
        this.#running = true;
        this.#generation = 1;
        this.#lastGitFingerprint = gitFingerprint(source.state);
        const target = liveBranchTarget(source.state);
        const now = new Date().toISOString();
        await this.#publishStatus({
            schemaVersion: 1,
            sessionId: randomUUID(),
            processId: process.pid,
            projectIdentifier: project.projectIdentifier,
            root,
            phase: "pending",
            generation: this.#generation,
            startedAt: now,
            updatedAt: now,
            reason: "initial",
            branch: target.branch,
            target: target.target,
        });

        try {
            this.#watcher = this.#watchRoot(
                root,
                (path) => {
                    if (isRelevantWatchPath(path)) {
                        this.#requestReconciliation("filesystem");
                    }
                },
                (error) => { void this.#handleWatcherError(error); },
            );
            const pollInterval = request.pollIntervalMilliseconds ?? 2_000;
            this.#pollTimer = setInterval(() => {
                void this.#poll();
            }, pollInterval);
            await this.#runReconciliation("initial");
            return this.#requiredStatus();
        } catch (error: unknown) {
            if (this.#running) await this.#publishFailure(error);
            await this.stop();
            throw error;
        }
    }

    async reconcile(): Promise<ProjectLiveIndexingStatus> {
        if (!this.#running) throw new Error("Live indexing is not running");
        this.#requestReconciliation("manual", true);
        await this.#runReconciliation("manual");
        return this.#requiredStatus();
    }

    async stop(): Promise<ProjectLiveIndexingStatus | undefined> {
        if (!this.#running) return this.#status;
        this.#running = false;
        if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
        if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
        this.#pollTimer = undefined;
        this.#debounceTimer = undefined;
        this.#watcher?.close();
        this.#watcher = undefined;
        this.#indexController?.abort(new Error("Live indexing stopped"));
        await this.#reconciliation?.catch(() => {});
        const current = this.#status;
        if (current !== undefined) {
            await this.#publishStatus({
                ...current,
                phase: "stopped",
                updatedAt: new Date().toISOString(),
            });
        }
        await this.#writeChain;
        return this.#status;
    }

    #requestReconciliation(
        reason: ProjectLiveIndexingReason,
        immediate = false,
    ): void {
        if (!this.#running) return;
        this.#generation += 1;
        const current = this.#requiredStatus();
        void this.#publishStatus({
            schemaVersion: 1,
            sessionId: current.sessionId,
            processId: current.processId,
            projectIdentifier: current.projectIdentifier,
            root: current.root,
            phase: "pending",
            generation: this.#generation,
            startedAt: current.startedAt,
            updatedAt: new Date().toISOString(),
            reason,
            ...(current.branch === undefined ? {} : { branch: current.branch }),
            ...(current.target === undefined ? {} : { target: current.target }),
        });
        if (this.#reconciliation !== undefined) return;
        if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
        const delay = immediate
            ? 0
            : this.#requiredRequest().debounceMilliseconds ?? 750;
        this.#debounceTimer = setTimeout(() => {
            this.#debounceTimer = undefined;
            void this.#runReconciliation(reason);
        }, delay);
    }

    async #runReconciliation(
        initialReason: ProjectLiveIndexingReason,
    ): Promise<void> {
        if (this.#reconciliation !== undefined) return this.#reconciliation;
        if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
        this.#debounceTimer = undefined;
        const run = this.#reconcileLoop(initialReason)
            .catch(async (error: unknown) => {
                if (this.#running) await this.#publishFailure(error);
            })
            .finally(() => {
                this.#reconciliation = undefined;
                if (this.#running && this.#status?.phase === "pending") {
                    this.#requestReconciliation(
                        this.#status.reason ?? "filesystem",
                    );
                }
            });
        this.#reconciliation = run;
        return run;
    }

    async #reconcileLoop(
        initialReason: ProjectLiveIndexingReason,
    ): Promise<void> {
        let reason = initialReason;
        while (this.#running) {
            const generation = this.#generation;
            const source = await this.#inspectSource(this.#requiredRequest().root);
            if (source.kind !== "git") {
                await this.#publishFailure(
                    new Error("The live indexing root is no longer a Git worktree"),
                );
                return;
            }
            this.#lastGitFingerprint = gitFingerprint(source.state);
            const branchTarget = liveBranchTarget(source.state);
            await this.#publishPhase(
                "indexing",
                generation,
                reason,
                branchTarget,
            );
            const controller = new AbortController();
            this.#indexController = controller;
            let outcome: ProjectIndexingOutcome;
            try {
                outcome = await this.#index(this.#indexRequest(controller.signal));
            } catch (error: unknown) {
                this.#indexController = undefined;
                if (!this.#running) return;
                if (this.#generation !== generation) {
                    reason = this.#status?.reason ?? "filesystem";
                    continue;
                }
                await this.#publishFailure(error, branchTarget);
                return;
            }
            this.#indexController = undefined;
            this.#diagnosedProvider = true;
            if (!this.#running) return;

            const latest = await this.#inspectSource(this.#requiredRequest().root);
            if (
                latest.kind !== "git" ||
                this.#generation !== generation ||
                gitFingerprint(latest.state) !== gitFingerprint(source.state)
            ) {
                reason = this.#status?.reason ?? "git";
                continue;
            }
            await this.#assignTarget(
                this.#requiredProject().projectIdentifier,
                branchTarget.target,
                outcome.result.indexBuildId,
                true,
                this.#requiredRequest().keepReplacedBuilds ?? 1,
            );
            const afterPublication = await this.#inspectSource(
                this.#requiredRequest().root,
            );
            if (
                afterPublication.kind !== "git" ||
                this.#generation !== generation ||
                gitFingerprint(afterPublication.state) !== gitFingerprint(source.state)
            ) {
                reason = this.#status?.reason ?? "filesystem";
                continue;
            }
            await this.#publishReady(
                generation,
                branchTarget,
                outcome.result.indexBuildId,
            );
            return;
        }
    }

    #indexRequest(signal: AbortSignal): ProjectIndexingRequest {
        const request = this.#requiredRequest();
        return {
            root: request.root,
            provider: request.provider,
            keepReplacedBuilds: request.keepReplacedBuilds ?? 1,
            allowDirty: true,
            diagnoseProvider: !this.#diagnosedProvider,
            persistRecipe: false,
            signal,
            onEvent: (event) => request.onEvent?.({
                type: "indexing",
                event,
            }),
            ...(request.maximumChunkSize === undefined
                ? {}
                : { maximumChunkSize: request.maximumChunkSize }),
            ...(request.windows1251 === undefined
                ? {}
                : { windows1251: request.windows1251 }),
            ...(request.include === undefined ? {} : { include: request.include }),
            ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
        };
    }

    async #poll(): Promise<void> {
        if (!this.#running || this.#polling) return;
        this.#polling = true;
        try {
            const source = await this.#inspectSource(this.#requiredRequest().root);
            if (source.kind !== "git") {
                await this.#publishFailure(
                    new Error("The live indexing root is no longer a Git worktree"),
                );
                return;
            }
            const fingerprint = gitFingerprint(source.state);
            if (fingerprint !== this.#lastGitFingerprint) {
                this.#lastGitFingerprint = fingerprint;
                this.#requestReconciliation("git");
            } else {
                await this.#heartbeat();
            }
        } catch (error: unknown) {
            await this.#publishFailure(error);
        } finally {
            this.#polling = false;
        }
    }

    async #heartbeat(): Promise<void> {
        const current = this.#status;
        if (current === undefined || !this.#running) return;
        await this.#publishStatus({
            ...current,
            updatedAt: new Date().toISOString(),
        }, false);
    }

    async #handleWatcherError(error: Error): Promise<void> {
        if (!this.#running) return;
        await this.#publishFailure(new Error(
            "Live filesystem watcher failed; retrieval is paused",
            { cause: error },
        ));
    }

    async #publishPhase(
        phase: "indexing",
        generation: number,
        reason: ProjectLiveIndexingReason,
        target: { branch: string; target: string },
    ): Promise<void> {
        const current = this.#requiredStatus();
        await this.#publishStatus({
            schemaVersion: 1,
            sessionId: current.sessionId,
            processId: current.processId,
            projectIdentifier: current.projectIdentifier,
            root: current.root,
            phase,
            generation,
            startedAt: current.startedAt,
            updatedAt: new Date().toISOString(),
            reason,
            branch: target.branch,
            target: target.target,
        });
    }

    async #publishReady(
        generation: number,
        target: { branch: string; target: string },
        indexBuildId: string,
    ): Promise<void> {
        const current = this.#requiredStatus();
        await this.#publishStatus({
            schemaVersion: 1,
            sessionId: current.sessionId,
            processId: current.processId,
            projectIdentifier: current.projectIdentifier,
            root: current.root,
            phase: "ready",
            generation,
            startedAt: current.startedAt,
            updatedAt: new Date().toISOString(),
            branch: target.branch,
            target: target.target,
            indexBuildId,
        });
    }

    async #publishFailure(
        error: unknown,
        target?: { branch: string; target: string },
    ): Promise<void> {
        const current = this.#requiredStatus();
        await this.#publishStatus({
            schemaVersion: 1,
            sessionId: current.sessionId,
            processId: current.processId,
            projectIdentifier: current.projectIdentifier,
            root: current.root,
            phase: "failed",
            generation: this.#generation,
            startedAt: current.startedAt,
            updatedAt: new Date().toISOString(),
            ...(current.reason === undefined ? {} : { reason: current.reason }),
            ...((target?.branch ?? current.branch) === undefined
                ? {}
                : { branch: target?.branch ?? current.branch! }),
            ...((target?.target ?? current.target) === undefined
                ? {}
                : { target: target?.target ?? current.target! }),
            error: serializeError(error),
        });
    }

    async #publishStatus(
        status: ProjectLiveIndexingStatus,
        emit = true,
    ): Promise<void> {
        this.#status = status;
        if (emit) this.#request?.onEvent?.({ type: "status", status });
        this.#writeChain = this.#writeChain.catch(() => {}).then(() =>
            this.#states.write(status));
        await this.#writeChain;
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
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
            throw new Error(`${label} must be a positive integer`);
        }
    }
    if (
        request.keepReplacedBuilds !== undefined &&
        (!Number.isSafeInteger(request.keepReplacedBuilds) ||
            request.keepReplacedBuilds < 0)
    ) {
        throw new Error("Live indexing retention must be a non-negative integer");
    }
}

function gitFingerprint(state: WorkingTreeState): string {
    return JSON.stringify({
        headCommit: state.headCommit ?? null,
        refName: state.refName ?? null,
        detached: state.detached,
        unborn: state.unborn,
        dirty: state.dirty,
        changes: state.changes,
    });
}

function isActiveSession(
    status: ProjectLiveIndexingStatus | undefined,
): boolean {
    return status !== undefined &&
        status.phase !== "stopped" &&
        Date.now() - Date.parse(status.updatedAt) <=
            LIVE_INDEXING_STALE_AFTER_MILLISECONDS;
}

function watchProjectRoot(
    root: string,
    onChange: (path?: string) => void,
    onError: (error: Error) => void,
): LiveWatcher {
    const watcher: FSWatcher = watch(
        root,
        { recursive: true },
        (_event, filename) => onChange(
            filename === null ? undefined : filename.toString(),
        ),
    );
    watcher.on("error", onError);
    return watcher;
}

function isRelevantWatchPath(path?: string): boolean {
    if (path === undefined) return true;
    const segments = path.replaceAll("\\", "/").split("/");
    return !segments.includes(".git") && !segments.includes("node_modules");
}
