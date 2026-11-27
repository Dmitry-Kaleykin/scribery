import {
    inspectSourceState,
    LIVE_CURRENT_TARGET,
    LIVE_INDEXING_STALE_AFTER_MILLISECONDS,
    normalizeRetrievalTargetName,
    ProjectIndexingService,
    ProjectLiveIndexingStateCatalog,
    ProjectRetrievalTargetService,
    type IndexedProjectSummary,
    type ProjectIndexingEvent,
} from "scribery-code";

import type { ScriberyMcpServerOptions } from "../contracts/server.js";

// Shared by server instances in this process. Reject competing mutations rather
// than queuing an index whose branch or selection could change while it waits.
const busyProjects = new Set<string>();

export class McpProjectManagementService {
    readonly #options: ScriberyMcpServerOptions;
    readonly #targets: ProjectRetrievalTargetService;
    readonly #indexing: ProjectIndexingService;
    readonly #liveStates: ProjectLiveIndexingStateCatalog;

    constructor(options: ScriberyMcpServerOptions) {
        this.#options = options;
        this.#targets = new ProjectRetrievalTargetService(options);
        this.#indexing = new ProjectIndexingService(options);
        this.#liveStates = new ProjectLiveIndexingStateCatalog(options.indexesDirectory);
    }

    async listTargets(): Promise<Readonly<Record<string, unknown>>> {
        const listing = await this.#targets.list(this.#options.defaultProjectReference);
        const targets = listing.targets as readonly { name: string; indexBuildId: string }[];
        const live = listing.live as { name: string; indexBuildId: string } | null;
        return {
            active: listing.active ?? null,
            targets: targets.map(({ name, indexBuildId }) => ({ name, indexBuildId })),
            ...(live === null ? {} : { live: { name: live.name, indexBuildId: live.indexBuildId } }),
        };
    }

    async switchTarget(target: string, signal?: AbortSignal): Promise<object> {
        const project = await this.#targets.resolveProject(this.#options.defaultProjectReference);
        return this.#mutate(project, async () => {
            await this.#assertManualMode(project);
            signal?.throwIfAborted();
            const result = await this.#targets.switchTarget(project.projectIdentifier, target);
            return { active: result.active };
        });
    }

    async indexCodebase(
        target?: string,
        signal?: AbortSignal,
        onEvent?: (event: ProjectIndexingEvent) => void,
    ): Promise<object> {
        const project = await this.#targets.resolveProject(this.#options.defaultProjectReference);
        return this.#mutate(project, async () => {
            await this.#assertManualMode(project);
            signal?.throwIfAborted();
            const recipe = await this.#indexing.recipe(project.projectIdentifier);
            if (recipe === undefined) {
                throw new Error("This project has no saved indexing settings. Run scribery index with your provider settings in the CLI/TUI first.");
            }
            if (project.root === undefined) {
                throw new Error("This project has no recorded source root. Configure it with scribery index in the CLI/TUI first.");
            }
            const source = await inspectSourceState(project.root, signal === undefined ? {} : { signal });
            const branch = source.kind === "git" ? source.state.refName : undefined;
            if (target === undefined && branch === undefined) {
                throw new Error("No current Git branch (detached HEAD or a plain directory). Call index_codebase with an explicit target.");
            }
            const destination = normalizeRetrievalTargetName(target ?? branch!);
            if (destination === LIVE_CURRENT_TARGET) {
                throw new Error(`${LIVE_CURRENT_TARGET} is reserved for live indexing; choose another target.`);
            }

            // Otherwise a completed but unpublished build could become the
            // implicit latest-ready selection even after cancellation/failure.
            const previous = await this.#targets.activeSelection(project);
            if (previous?.type === "latest-ready") {
                signal?.throwIfAborted();
                await this.#targets.switchBuild(project.projectIdentifier, previous.indexBuildId);
            }

            // Keep the saved manual recipe intact. Build first, then validate and
            // publish, as live indexing does; failures never advance a target.
            const { target: _savedTarget, ...settings } = recipe;
            const outcome = await this.#indexing.index({
                ...settings,
                root: project.root,
                databasePath: project.databasePath,
                persistRecipe: false,
                ...(signal === undefined ? {} : { signal }),
                ...(onEvent === undefined ? {} : { onEvent }),
            });
            signal?.throwIfAborted();
            const current = await inspectSourceState(project.root, signal === undefined ? {} : { signal });
            if (source.kind !== current.kind || (source.kind === "git" && current.kind === "git" && (
                source.state.refName !== current.state.refName ||
                source.state.headCommit !== current.state.headCommit
            ))) {
                throw new Error("Git branch or HEAD changed while indexing. The target was not updated; retry index_codebase on the intended branch.");
            }
            await this.#assertManualMode(project);
            signal?.throwIfAborted();
            const published = await this.#targets.assignTarget(
                project.projectIdentifier,
                destination,
                outcome.result.indexBuildId,
                true,
                recipe.keepReplacedBuilds,
            );
            const retention = published.retention as { cleanupFailures?: unknown[] } | undefined;
            return {
                status: "ready",
                active: published.active,
                files: outcome.summary.indexedDocuments,
                chunks: outcome.summary.indexedChunks,
                generatedEmbeddings: outcome.summary.generatedEmbeddings,
                reusedEmbeddings: outcome.summary.reusedEmbeddings,
                diagnosticCount: outcome.summary.diagnosticCount,
                ...(outcome.summary.diagnosticCount === 0 && !retention?.cleanupFailures?.length
                    ? {}
                    : { logPath: outcome.summary.logPath }),
                ...(!retention?.cleanupFailures?.length ? {} : { cleanupFailures: retention.cleanupFailures }),
            };
        });
    }

    async #assertManualMode(project: IndexedProjectSummary): Promise<void> {
        const live = await this.#liveStates.read(project.projectIdentifier);
        if (live !== undefined && live.phase !== "stopped" &&
            Date.now() - Date.parse(live.updatedAt) <= LIVE_INDEXING_STALE_AFTER_MILLISECONDS) {
            throw new Error("Stop live indexing in the TUI before indexing or switching targets through MCP.");
        }
        await this.#targets.recoverLiveSession(project);
    }

    async #mutate<T>(project: IndexedProjectSummary, operation: () => Promise<T>): Promise<T> {
        const key = project.databasePath;
        if (busyProjects.has(key)) {
            throw new Error("A project indexing or target operation is already running. Retry after it completes.");
        }
        busyProjects.add(key);
        try {
            return await operation();
        } finally {
            busyProjects.delete(key);
        }
    }
}
