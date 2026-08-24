import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
    MANAGED_DATABASE_FILENAME,
    MANAGED_PROJECT_MANIFEST_FILENAME,
} from "scribery-core";
import type { IndexBuildRecord, IndexBuildStatus } from "scribery-core";
import { SqliteStorageProvider } from "scribery-core";
import { readManagedProjectManifest } from "./manifest.js";
import {
    managedIndexesDirectory,
    validateManagedProjectIdentifier,
} from "./paths.js";

export interface IndexedProjectSummary {
    projectIdentifier: string;
    root?: string;
    databasePath: string;
    databaseBytes: number;
    buildCount: number;
    buildsByStatus: Record<IndexBuildStatus, number>;
    latestReadyBuild?: {
        indexBuildId: string;
        completedAt?: string;
        model: string;
        dimensions: number;
    };
    error?: string;
}

export async function listIndexedProjects(
    indexesDirectory = managedIndexesDirectory(),
): Promise<readonly IndexedProjectSummary[]> {
    const entries = await readManagedIndexEntries(indexesDirectory);
    const projects: IndexedProjectSummary[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || !isManagedProjectIdentifier(entry.name)) {
            continue;
        }

        const projectDirectory = join(indexesDirectory, entry.name);
        const databasePath = join(projectDirectory, MANAGED_DATABASE_FILENAME);
        const databaseStat = await optionalFileStat(databasePath);

        if (databaseStat === undefined) {
            continue;
        }

        const manifest = await readManagedProjectManifest(join(
            projectDirectory,
            MANAGED_PROJECT_MANIFEST_FILENAME,
        ));
        const root = manifest !== undefined &&
            manifest.projectIdentifier === entry.name
            ? manifest.root
            : undefined;

        try {
            const storage = new SqliteStorageProvider(databasePath, {
                readOnly: true,
                immutable: true,
            });

            try {
                const builds = await storage.listBuilds();
                projects.push(createProjectSummary(
                    entry.name,
                    databasePath,
                    databaseStat.size,
                    root,
                    builds,
                ));
            } finally {
                await storage.close();
            }
        } catch (error: unknown) {
            projects.push({
                projectIdentifier: entry.name,
                ...(root === undefined ? {} : { root }),
                databasePath,
                databaseBytes: databaseStat.size,
                buildCount: 0,
                buildsByStatus: emptyStatusCounts(),
                error: error instanceof Error
                    ? error.message
                    : "Index database could not be read",
            });
        }
    }

    return projects.sort((left, right) =>
        (left.root ?? left.projectIdentifier).localeCompare(
            right.root ?? right.projectIdentifier,
        )
    );
}

function createProjectSummary(
    projectIdentifier: string,
    databasePath: string,
    databaseBytes: number,
    root: string | undefined,
    builds: readonly IndexBuildRecord[],
): IndexedProjectSummary {
    const buildsByStatus = emptyStatusCounts();

    for (const build of builds) {
        buildsByStatus[build.status] += 1;
    }

    const latestReadyBuild = builds.find(({ status }) => status === "ready");
    return {
        projectIdentifier,
        ...(root === undefined ? {} : { root }),
        databasePath,
        databaseBytes,
        buildCount: builds.length,
        buildsByStatus,
        ...(latestReadyBuild === undefined
            ? {}
            : {
                latestReadyBuild: {
                    indexBuildId: latestReadyBuild.indexBuildId,
                    ...(latestReadyBuild.completedAt === undefined
                        ? {}
                        : { completedAt: latestReadyBuild.completedAt }),
                    model: latestReadyBuild.modelIdentity.model,
                    dimensions: latestReadyBuild.modelIdentity.dimensions,
                },
            }),
    };
}

function emptyStatusCounts(): Record<IndexBuildStatus, number> {
    return { building: 0, ready: 0, failed: 0, cancelled: 0 };
}

async function readManagedIndexEntries(
    indexesDirectory: string,
): Promise<Dirent[]> {
    try {
        return await readdir(indexesDirectory, { withFileTypes: true });
    } catch (error: unknown) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return [];
        }

        throw error;
    }
}

async function optionalFileStat(path: string): Promise<Stats | undefined> {
    try {
        const result = await stat(path);
        return result.isFile() ? result : undefined;
    } catch (error: unknown) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return undefined;
        }

        throw error;
    }
}

function isManagedProjectIdentifier(value: string): boolean {
    try {
        validateManagedProjectIdentifier(value);
        return true;
    } catch {
        return false;
    }
}
