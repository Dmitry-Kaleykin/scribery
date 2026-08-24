import type { IndexingProgress } from "scribery";

export function shouldRenderIndexingProgressImmediately(
    previous: IndexingProgress | undefined,
    current: IndexingProgress,
): boolean {
    if (previous?.phase !== current.phase) return true;

    return current.phase === "processing" &&
        current.activity === "chunking" &&
        current.currentPath !== previous.currentPath;
}
