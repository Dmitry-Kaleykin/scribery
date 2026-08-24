import type { IndexingProgress } from "scribery-core";
import { INDEXING_PROGRESS_RENDER_INTERVAL_MILLISECONDS } from "../constants/progress.js";

export function createCliProgressReporter(): (
    progress: IndexingProgress,
) => void {
    let previousPhase: IndexingProgress["phase"] | undefined;
    let lastRenderedAt = 0;

    return (progress) => {
        const now = Date.now();
        const phaseChanged = progress.phase !== previousPhase;
        const reachedTotal = progress.total !== undefined &&
            progress.completed === progress.total;

        if (
            !phaseChanged &&
            !reachedTotal &&
            now - lastRenderedAt < INDEXING_PROGRESS_RENDER_INTERVAL_MILLISECONDS
        ) {
            return;
        }

        console.error(`[index] ${formatProgress(progress)}`);
        previousPhase = progress.phase;
        lastRenderedAt = now;
    };
}

function formatProgress(progress: IndexingProgress): string {
    switch (progress.phase) {
        case "source-inspection":
            return "Inspecting source state...";
        case "discovery":
            return `Reading files: ${progress.discoveredFiles ?? 0} ` +
                `(${formatBytes(progress.discoveredBytes ?? 0)})` +
                formatCurrentPath(progress.currentPath);
        case "preparing-build":
            return "Preparing index build...";
        case "processing":
            return `${progress.activity === "chunking"
                ? "Chunking file"
                : "Processing files"}: ${formatCount(progress)}; ` +
                `${progress.queuedChunks ?? 0} chunks queued; ` +
                `${progress.reusedDocuments ?? 0} documents reused` +
                formatCurrentPath(progress.currentPath);
        case "embedding":
            return `Resolving embeddings: ${formatCount(progress)}; ` +
                `${progress.reusedEmbeddings ?? 0} cached, ` +
                `${progress.generatedEmbeddings ?? 0} generated`;
        case "storage":
            return `Storing chunks: ${formatCount(progress)}`;
        case "finalizing":
            return "Publishing ready index build...";
        case "complete":
            if (progress.reusedBuild === true) {
                return `Existing ready index reused: ` +
                    `${progress.discoveredFiles ?? 0} files`;
            }

            return `Index complete: ${progress.discoveredFiles ?? 0} files, ` +
                `${progress.queuedChunks ?? 0} chunks, ` +
                `${progress.reusedDocuments ?? 0} documents reused, ` +
                `${progress.reusedEmbeddings ?? 0} embeddings cached, ` +
                `${progress.generatedEmbeddings ?? 0} embeddings generated`;
    }
}

function formatCount(progress: IndexingProgress): string {
    return progress.total === undefined
        ? String(progress.completed ?? 0)
        : `${progress.completed ?? 0}/${progress.total}`;
}

function formatCurrentPath(path: string | undefined): string {
    return path === undefined ? "" : `; ${path}`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
    return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
