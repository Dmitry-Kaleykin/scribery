import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SqliteStorageProvider } from "scribery-core";
import type { IndexedProjectSummary } from "../managed/list-projects.js";
import { managedProjectDirectory } from "../managed/paths.js";
import { ProjectRetrievalTargetCatalog } from "../retrieval/target-catalog.js";
import { ProjectLiveIndexingStateCatalog, LIVE_INDEXING_STALE_AFTER_MILLISECONDS } from "./live-state-catalog.js";

export const DEFAULT_LIVE_CACHE_BUILD_LIMIT = 20;

interface CachedBuild {
    indexBuildId: string;
    lastUsedAt: string;
}

/** Only explicitly tracked live builds are eligible for cache eviction. */
export class ProjectLiveBuildCache {
    readonly #indexesDirectory: string;

    constructor(indexesDirectory: string) {
        this.#indexesDirectory = indexesDirectory;
    }

    async record(projectIdentifier: string, indexBuildId: string, reused: boolean): Promise<void> {
        const entries = await this.#read(projectIdentifier);
        if (reused && !entries.some((entry) => entry.indexBuildId === indexBuildId)) return;
        await this.#write(projectIdentifier, [
            { indexBuildId, lastUsedAt: new Date().toISOString() },
            ...entries.filter((entry) => entry.indexBuildId !== indexBuildId),
        ]);
    }

    async prune(project: IndexedProjectSummary, limit: number): Promise<void> {
        const entries = await this.#read(project.projectIdentifier);
        if (entries.length <= limit) return;
        const manifest = await new ProjectRetrievalTargetCatalog(this.#indexesDirectory)
            .read(project.projectIdentifier);
        const live = await new ProjectLiveIndexingStateCatalog(this.#indexesDirectory)
            .read(project.projectIdentifier);
        const protectedIds = new Set<string>();
        for (const target of manifest.targets) {
            protectedIds.add(target.indexBuildId);
            for (const build of target.retainedBuildIds ?? []) protectedIds.add(build);
        }
        if (manifest.active?.type === "build") protectedIds.add(manifest.active.indexBuildId);
        if (live !== undefined && live.phase !== "stopped" &&
            Date.now() - Date.parse(live.updatedAt) <= LIVE_INDEXING_STALE_AFTER_MILLISECONDS) {
            if (live?.indexBuildId !== undefined) protectedIds.add(live.indexBuildId);
            if (live?.previousSelection?.type === "build") {
                protectedIds.add(live.previousSelection.indexBuildId);
            }
        }
        const storage = new SqliteStorageProvider(project.databasePath);
        try {
            const builds = await storage.listBuilds();
            if (manifest.active === undefined) {
                const latest = builds.find(({ status }) => status === "ready");
                if (latest !== undefined) protectedIds.add(latest.indexBuildId);
            }
            const byId = new Map(builds.map((build) => [build.indexBuildId, build]));
            const retained: CachedBuild[] = [];
            let unreferenced = 0;
            for (const entry of entries) {
                const build = byId.get(entry.indexBuildId);
                if (build === undefined) continue;
                if (protectedIds.has(entry.indexBuildId) || build.status === "building") {
                    retained.push(entry);
                } else if (unreferenced++ < limit) {
                    retained.push(entry);
                } else {
                    await storage.deleteBuild(entry.indexBuildId);
                }
            }
            await this.#write(project.projectIdentifier, retained);
        } finally {
            await storage.close();
        }
    }

    async #read(projectIdentifier: string): Promise<readonly CachedBuild[]> {
        try {
            const value: unknown = JSON.parse(await readFile(this.#path(projectIdentifier), "utf8"));
            if (!Array.isArray(value) || value.some((entry: unknown) => {
                if (typeof entry !== "object" || entry === null) return true;
                const candidate = entry as Partial<CachedBuild>;
                return typeof candidate.indexBuildId !== "string" || candidate.indexBuildId.length === 0 ||
                    typeof candidate.lastUsedAt !== "string" || !Number.isFinite(Date.parse(candidate.lastUsedAt));
            })) throw new Error("Project live build cache is invalid");
            return value as CachedBuild[];
        } catch (error: unknown) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
            throw error;
        }
    }

    async #write(projectIdentifier: string, entries: readonly CachedBuild[]): Promise<void> {
        const path = this.#path(projectIdentifier);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await mkdir(managedProjectDirectory(projectIdentifier, this.#indexesDirectory), { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, path);
    }

    #path(projectIdentifier: string): string {
        return join(managedProjectDirectory(projectIdentifier, this.#indexesDirectory), "live-build-cache.json");
    }
}
