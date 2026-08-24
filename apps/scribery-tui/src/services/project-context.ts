import { isAbsolute, relative, resolve, sep } from "node:path";

import type { IndexedProjectSummary } from "scribery";

export function projectForDirectory(
    projects: readonly IndexedProjectSummary[],
    directory: string,
): IndexedProjectSummary | undefined {
    const current = resolve(directory);
    return projects
        .filter((project) => project.root !== undefined && isWithin(project.root, current))
        .sort((left, right) => (right.root?.length ?? 0) - (left.root?.length ?? 0))[0];
}

function isWithin(root: string, candidate: string): boolean {
    const path = relative(resolve(root), candidate);
    return path === "" || (
        path !== ".." &&
        !path.startsWith(`..${sep}`) &&
        !isAbsolute(path)
    );
}
