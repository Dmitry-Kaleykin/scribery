import {
    type DeletedIndexBuild,
    type IndexBuildRecord,
    SqliteStorageProvider,
} from "scribery-core";
import type {
    ProjectRetrievalTarget,
    ProjectRetrievalTargets,
    ProjectRetrievalSelection,
    ResolvedProjectRetrievalSelection,
} from "../contracts/retrieval-target.js";
import {
    listIndexedProjects,
    type IndexedProjectSummary,
} from "../managed/list-projects.js";
import { managedIndexesDirectory } from "../managed/paths.js";
import { resolveIndexedProject } from "../managed/resolve-project.js";
import {
    normalizeRetrievalTargetName,
    ProjectRetrievalTargetCatalog,
} from "./target-catalog.js";
import { ProjectLiveIndexingStateCatalog, LIVE_INDEXING_STALE_AFTER_MILLISECONDS } from "../live/live-state-catalog.js";
import { LIVE_CURRENT_TARGET } from "../live/live-target.js";
import { ProjectLiveBuildCache } from "../live/live-build-cache.js";

export interface ProjectRetrievalTargetServiceOptions {
    indexesDirectory?: string;
}

export class ProjectRetrievalTargetService {
    readonly #catalog: ProjectRetrievalTargetCatalog;
    readonly #indexesDirectory: string;

    constructor(options: ProjectRetrievalTargetServiceOptions = {}) {
        this.#indexesDirectory = options.indexesDirectory ?? managedIndexesDirectory();
        this.#catalog = new ProjectRetrievalTargetCatalog(this.#indexesDirectory);
    }

    async resolveProject(
        reference?: string,
        currentDirectory = process.cwd(),
    ): Promise<IndexedProjectSummary> {
        return resolveIndexedProject(
            await listIndexedProjects(this.#indexesDirectory),
            reference,
            currentDirectory,
        );
    }

    async list(
        reference?: string,
        currentDirectory = process.cwd(),
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        await this.recoverLiveSession(project);
        const manifest = await this.#catalog.read(project.projectIdentifier);
        const resolved = resolveSelection(manifest, project);

        return {
            projectIdentifier: project.projectIdentifier,
            ...(project.root === undefined ? {} : { root: project.root }),
            active: resolved,
            live: manifest.targets.find((target) => target.liveSessionId !== undefined) ?? null,
            targetCount: manifest.targets.filter((target) => target.liveSessionId === undefined).length,
            targets: manifest.targets.filter((target) => target.liveSessionId === undefined).map((target) => ({
                ...target,
                active: manifest.active?.type === "target" &&
                    manifest.active.target === target.name,
            })),
        };
    }

    async status(
        reference?: string,
        currentDirectory = process.cwd(),
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        await this.recoverLiveSession(project);
        const manifest = await this.#catalog.read(project.projectIdentifier);
        const selection = resolveSelection(manifest, project);

        if (selection === undefined) {
            return {
                projectIdentifier: project.projectIdentifier,
                ...(project.root === undefined ? {} : { root: project.root }),
                active: null,
                ready: false,
            };
        }

        const build = await this.#readyBuild(project, selection.indexBuildId);
        return {
            projectIdentifier: project.projectIdentifier,
            ...(project.root === undefined ? {} : { root: project.root }),
            active: selection,
            ready: true,
            build,
        };
    }

    async assignTarget(
        projectReference: string,
        target: string,
        indexBuildId: string,
        activate = false,
        keepReplacedBuilds?: number,
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(projectReference);
        await this.#readyBuild(project, indexBuildId);
        const previousManifest = await this.#catalog.read(project.projectIdentifier);
        const normalizedTarget = normalizeRetrievalTargetName(target);
        const previousTarget = previousManifest.targets.find(
            ({ name }) => name === normalizedTarget,
        );
        const manifest = await this.#catalog.setTarget(
            project.projectIdentifier,
            normalizedTarget,
            indexBuildId,
            activate,
            keepReplacedBuilds,
        );
        const retention = keepReplacedBuilds === undefined
            ? undefined
            : await this.#removeReleasedBuilds(
                project,
                previousTarget,
                manifest,
                normalizedTarget,
                keepReplacedBuilds,
            );
        return {
            ...assignmentResult(project, manifest, normalizedTarget),
            ...(retention === undefined ? {} : { retention }),
        };
    }

    async assignLiveTarget(projectReference: string, indexBuildId: string, sessionId: string): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(projectReference);
        await this.#readyBuild(project, indexBuildId);
        const manifest = await this.#catalog.setTarget(
            project.projectIdentifier, LIVE_CURRENT_TARGET, indexBuildId, true, undefined, sessionId,
        );
        return assignmentResult(project, manifest, LIVE_CURRENT_TARGET);
    }

    async previousSelection(project: IndexedProjectSummary): Promise<ProjectRetrievalSelection> {
        await this.recoverLiveSession(project);
        const manifest = await this.#catalog.read(project.projectIdentifier);
        if (manifest.active !== undefined) return manifest.active;
        // Freeze the fallback before live builds become the newest ready builds.
        return project.latestReadyBuild === undefined
            ? { type: "none" }
            : { type: "build", indexBuildId: project.latestReadyBuild.indexBuildId };
    }

    async releaseLiveTarget(projectIdentifier: string, sessionId: string, previousSelection: ProjectRetrievalSelection): Promise<void> {
        await this.#catalog.releaseLiveTarget(projectIdentifier, sessionId, previousSelection);
    }

    async recoverLiveSession(project: IndexedProjectSummary): Promise<void> {
        const states = new ProjectLiveIndexingStateCatalog(this.#indexesDirectory);
        const status = await states.read(project.projectIdentifier);
        if (status === undefined || status.previousSelection === undefined ||
            (status.phase !== "stopped" && Date.now() - Date.parse(status.updatedAt) <= LIVE_INDEXING_STALE_AFTER_MILLISECONDS)) return;
        await this.releaseLiveTarget(project.projectIdentifier, status.sessionId, status.previousSelection);
    }

    async cleanupLegacyLiveTargets(reference?: string, currentDirectory = process.cwd()): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        const status = await new ProjectLiveIndexingStateCatalog(this.#indexesDirectory).read(project.projectIdentifier);
        if (status !== undefined && status.phase !== "stopped" &&
            Date.now() - Date.parse(status.updatedAt) <= LIVE_INDEXING_STALE_AFTER_MILLISECONDS) {
            throw new Error("Stop live indexing before cleaning up legacy live targets");
        }
        await this.recoverLiveSession(project);
        const removed = await this.#catalog.removeLegacyLiveTargets(project.projectIdentifier);
        const cache = new ProjectLiveBuildCache(this.#indexesDirectory);
        for (const target of removed) {
            for (const buildId of [target.indexBuildId, ...(target.retainedBuildIds ?? [])]) {
                await cache.record(project.projectIdentifier, buildId, false);
            }
        }
        return { projectIdentifier: project.projectIdentifier, removed: removed.map(({ name }) => name) };
    }

    async switchTarget(
        reference: string | undefined,
        target: string,
        currentDirectory = process.cwd(),
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        const normalizedTarget = normalizeRetrievalTargetName(target);
        const manifest = await this.#catalog.read(project.projectIdentifier);
        const entry = manifest.targets.find(({ name }) => name === normalizedTarget);

        if (entry === undefined) {
            throw new Error(`Retrieval target ${normalizedTarget} was not found`);
        }

        await this.#readyBuild(project, entry.indexBuildId);
        const updated = await this.#catalog.setActive(project.projectIdentifier, {
            type: "target",
            target: normalizedTarget,
        });
        return selectionResult(project, resolveSelection(updated, project)!);
    }

    async switchBuild(
        reference: string | undefined,
        indexBuildId: string,
        currentDirectory = process.cwd(),
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        await this.#readyBuild(project, indexBuildId);
        const updated = await this.#catalog.setActive(project.projectIdentifier, {
            type: "build",
            indexBuildId,
        });
        return selectionResult(project, resolveSelection(updated, project)!);
    }

    async deactivate(
        reference?: string,
        currentDirectory = process.cwd(),
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        await this.#catalog.setActive(project.projectIdentifier, {
            type: "none",
        });
        return {
            projectIdentifier: project.projectIdentifier,
            ...(project.root === undefined ? {} : { root: project.root }),
            active: null,
        };
    }

    async removeTarget(
        reference: string | undefined,
        target: string,
        currentDirectory = process.cwd(),
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        const normalizedTarget = normalizeRetrievalTargetName(target);
        const updated = await this.#catalog.removeTarget(
            project.projectIdentifier,
            normalizedTarget,
        );
        return {
            projectIdentifier: project.projectIdentifier,
            removed: normalizedTarget,
            targetCount: updated.targets.length,
            active: resolveSelection(updated, project),
        };
    }

    async renameTarget(
        reference: string | undefined,
        target: string,
        nextTarget: string,
        currentDirectory = process.cwd(),
    ): Promise<Readonly<Record<string, unknown>>> {
        const project = await this.resolveProject(reference, currentDirectory);
        const normalizedTarget = normalizeRetrievalTargetName(target);
        const normalizedNextTarget = normalizeRetrievalTargetName(nextTarget);
        const updated = await this.#catalog.renameTarget(
            project.projectIdentifier,
            normalizedTarget,
            normalizedNextTarget,
        );
        return {
            projectIdentifier: project.projectIdentifier,
            ...(project.root === undefined ? {} : { root: project.root }),
            renamed: {
                from: normalizedTarget,
                to: normalizedNextTarget,
            },
            target: updated.targets.find(
                ({ name }) => name === normalizedNextTarget,
            ),
            active: resolveSelection(updated, project),
        };
    }

    async activeSelection(
        project: IndexedProjectSummary,
    ): Promise<ResolvedProjectRetrievalSelection | undefined> {
        await this.recoverLiveSession(project);
        return resolveSelection(
            await this.#catalog.read(project.projectIdentifier),
            project,
        );
    }

    async deleteBuild(
        reference: string | undefined,
        indexBuildId: string,
        currentDirectory = process.cwd(),
    ): Promise<DeletedIndexBuild> {
        const project = await this.resolveProject(reference, currentDirectory);
        await this.recoverLiveSession(project);
        const manifest = await this.#catalog.read(project.projectIdentifier);
        const protectedBuildIds = new Set(referencedBuildIds(manifest));
        for (const buildId of await this.#liveProtectedBuildIds(project.projectIdentifier)) {
            protectedBuildIds.add(buildId);
        }
        const active = resolveSelection(manifest, project);

        if (active !== undefined) {
            protectedBuildIds.add(active.indexBuildId);
        }

        if (protectedBuildIds.has(indexBuildId)) {
            throw new Error(
                `Index build ${indexBuildId} is active or referenced by a retrieval target and cannot be deleted`,
            );
        }

        const storage = new SqliteStorageProvider(project.databasePath);

        try {
            if (await storage.getBuild(indexBuildId) === undefined) {
                throw new Error(`Index build ${indexBuildId} was not found`);
            }

            return await storage.deleteBuild(indexBuildId);
        } finally {
            await storage.close();
        }
    }

    async #readyBuild(
        project: IndexedProjectSummary,
        indexBuildId: string,
    ): Promise<IndexBuildRecord> {
        const storage = new SqliteStorageProvider(project.databasePath, {
            readOnly: true,
            immutable: true,
        });

        try {
            const build = await storage.getBuild(indexBuildId);
            if (build === undefined) {
                throw new Error(`Index build ${indexBuildId} was not found`);
            }
            if (build.status !== "ready") {
                throw new Error(
                    `Index build ${indexBuildId} is ${build.status}; only ready builds can be selected`,
                );
            }
            return build;
        } finally {
            await storage.close();
        }
    }

    async #removeReleasedBuilds(
        project: IndexedProjectSummary,
        previousTarget: ProjectRetrievalTarget | undefined,
        manifest: ProjectRetrievalTargets,
        target: string,
        keepReplacedBuilds: number,
    ): Promise<Readonly<Record<string, unknown>>> {
        const currentTarget = manifest.targets.find(({ name }) => name === target)!;
        const retainedBuildIds = currentTarget.retainedBuildIds ?? [];
        const previousBuildIds = targetBuildIds(previousTarget);
        const currentBuildIds = new Set(targetBuildIds(currentTarget));
        const protectedBuildIds = new Set(referencedBuildIds(manifest));
        for (const buildId of await this.#liveProtectedBuildIds(project.projectIdentifier)) {
            protectedBuildIds.add(buildId);
        }
        const releasedBuildIds = previousBuildIds.filter(
            (indexBuildId) => !currentBuildIds.has(indexBuildId),
        );
        const deletableBuildIds = releasedBuildIds.filter(
            (indexBuildId) => !protectedBuildIds.has(indexBuildId),
        );
        const protectedReleasedBuildIds = releasedBuildIds.filter(
            (indexBuildId) => protectedBuildIds.has(indexBuildId),
        );
        const deletedBuilds: DeletedIndexBuild[] = [];
        const missingBuildIds: string[] = [];
        const cleanupFailures: Array<Readonly<Record<string, string>>> = [];

        if (deletableBuildIds.length > 0) {
            const storage = new SqliteStorageProvider(project.databasePath);

            try {
                for (const indexBuildId of deletableBuildIds) {
                    try {
                        if (await storage.getBuild(indexBuildId) === undefined) {
                            missingBuildIds.push(indexBuildId);
                            continue;
                        }
                        deletedBuilds.push(await storage.deleteBuild(indexBuildId));
                    } catch (error: unknown) {
                        cleanupFailures.push({
                            indexBuildId,
                            message: error instanceof Error
                                ? error.message
                                : "Index build cleanup failed",
                        });
                    }
                }
            } finally {
                await storage.close();
            }
        }

        return {
            keepReplacedBuilds,
            retainedBuildIds,
            deletedBuilds,
            ...(protectedReleasedBuildIds.length === 0
                ? {}
                : { protectedBuildIds: protectedReleasedBuildIds }),
            ...(missingBuildIds.length === 0 ? {} : { missingBuildIds }),
            ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
        };
    }

    async #liveProtectedBuildIds(projectIdentifier: string): Promise<readonly string[]> {
        const live = await new ProjectLiveIndexingStateCatalog(this.#indexesDirectory).read(projectIdentifier);
        if (live === undefined || live.phase === "stopped" ||
            Date.now() - Date.parse(live.updatedAt) > LIVE_INDEXING_STALE_AFTER_MILLISECONDS) return [];
        return [
            ...(live.indexBuildId === undefined ? [] : [live.indexBuildId]),
            ...(live.previousSelection?.type === "build" ? [live.previousSelection.indexBuildId] : []),
        ];
    }
}

function targetBuildIds(
    target: ProjectRetrievalTarget | undefined,
): readonly string[] {
    return target === undefined
        ? []
        : [target.indexBuildId, ...(target.retainedBuildIds ?? [])];
}

function referencedBuildIds(
    manifest: ProjectRetrievalTargets,
): ReadonlySet<string> {
    const buildIds = new Set<string>();

    for (const target of manifest.targets) {
        for (const indexBuildId of targetBuildIds(target)) {
            buildIds.add(indexBuildId);
        }
    }
    if (manifest.active?.type === "build") {
        buildIds.add(manifest.active.indexBuildId);
    }

    return buildIds;
}

function resolveSelection(
    manifest: ProjectRetrievalTargets,
    project: IndexedProjectSummary,
): ResolvedProjectRetrievalSelection | undefined {
    if (manifest.active?.type === "none") return undefined;
    if (manifest.active?.type === "target") {
        const activeTarget = manifest.active.target;
        const target = manifest.targets.find(({ name }) => name === activeTarget);

        if (target === undefined) {
            throw new Error("Active project retrieval target was not found");
        }

        return {
            type: "target",
            target: target.name,
            indexBuildId: target.indexBuildId,
        };
    }
    if (manifest.active?.type === "build") {
        return {
            type: "build",
            indexBuildId: manifest.active.indexBuildId,
        };
    }
    if (project.latestReadyBuild !== undefined) {
        return {
            type: "latest-ready",
            indexBuildId: project.latestReadyBuild.indexBuildId,
        };
    }

    return undefined;
}

function assignmentResult(
    project: IndexedProjectSummary,
    manifest: ProjectRetrievalTargets,
    target: string,
): Readonly<Record<string, unknown>> {
    const entry = manifest.targets.find(({ name }) => name === target)!;
    return {
        projectIdentifier: project.projectIdentifier,
        ...(project.root === undefined ? {} : { root: project.root }),
        target: entry,
        active: resolveSelection(manifest, project),
    };
}

function selectionResult(
    project: IndexedProjectSummary,
    selection: ResolvedProjectRetrievalSelection,
): Readonly<Record<string, unknown>> {
    return {
        projectIdentifier: project.projectIdentifier,
        ...(project.root === undefined ? {} : { root: project.root }),
        active: selection,
    };
}
