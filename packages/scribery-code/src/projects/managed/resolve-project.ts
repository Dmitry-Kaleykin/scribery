import { isAbsolute, relative, resolve, sep } from "node:path";

import type { IndexedProjectSummary } from "./list-projects.js";

export function resolveIndexedProject(
    projects: readonly IndexedProjectSummary[],
    reference?: string,
    currentDirectory = process.cwd(),
): IndexedProjectSummary {
    if (reference !== undefined) {
        const trimmed = reference.trim();
        const resolvedReference = resolve(trimmed);
        const matches = projects.filter((project) =>
            project.projectIdentifier === trimmed ||
            resolve(project.databasePath) === resolvedReference ||
            (project.root !== undefined && resolve(project.root) === resolvedReference)
        );

        if (matches.length !== 1) {
            throw new Error(`Indexed project ${reference} was not found`);
        }

        return matches[0]!;
    }

    const resolvedCurrentDirectory = resolve(currentDirectory);
    const containingProjects = projects
        .filter(({ root }) => root !== undefined && isWithin(root, resolvedCurrentDirectory))
        .sort((left, right) => (right.root?.length ?? 0) - (left.root?.length ?? 0));

    if (containingProjects.length > 0) return containingProjects[0]!;
    if (projects.length === 1) return projects[0]!;
    if (projects.length === 0) {
        throw new Error("No indexed projects are available");
    }

    throw new Error(
        "Multiple indexed projects are available; provide --project or run the command inside an indexed project",
    );
}

function isWithin(root: string, candidate: string): boolean {
    const path = relative(resolve(root), candidate);
    return path === "" || (
        path !== ".." &&
        !path.startsWith(`..${sep}`) &&
        !isAbsolute(path)
    );
}
