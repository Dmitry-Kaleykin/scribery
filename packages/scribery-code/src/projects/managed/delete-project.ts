import { lstat, rm } from "node:fs/promises";

import {
    managedIndexesDirectory,
    managedProjectDirectory,
} from "./paths.js";

export interface DeletedProject {
    projectIdentifier: string;
    deletedPath: string;
}

export async function deleteIndexedProject(
    projectIdentifier: string,
    indexesDirectory = managedIndexesDirectory(),
): Promise<DeletedProject> {
    const projectDirectory = managedProjectDirectory(
        projectIdentifier,
        indexesDirectory,
    );
    let projectStat;

    try {
        projectStat = await lstat(projectDirectory);
    } catch (error: unknown) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            throw new Error(`Indexed project ${projectIdentifier} was not found`);
        }

        throw error;
    }

    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
        throw new Error("Managed project path is not a normal directory");
    }

    await rm(projectDirectory, { recursive: true, force: false });
    return { projectIdentifier, deletedPath: projectDirectory };
}
