import type { ProjectIndexingEvent } from "scribery-code";
import { INDEXING_PROGRESS_RENDER_INTERVAL_MILLISECONDS } from "../constants/progress.js";
import { createCliProgressReporter } from "./indexing-progress.js";

export function createProjectIndexingEventReporter(
    format: "human" | "json",
): (event: ProjectIndexingEvent) => void {
    if (format === "json") return createJsonReporter();

    const reportIndexingProgress = createCliProgressReporter();
    return (event) => {
        switch (event.type) {
            case "provider-diagnostic":
                if (event.state === "started") {
                    console.error(
                        `[index] Checking embedding model: ${event.model} ` +
                        `(${event.dimensions} dimensions)...`,
                    );
                } else {
                    console.error(
                        `[index] Embedding model ready: ${event.result.model} ` +
                        `(${event.result.dimensions} dimensions)`,
                    );
                }
                return;
            case "indexing-progress":
                reportIndexingProgress(event.progress);
                return;
            case "target-publication":
                if (event.state === "started") {
                    console.error(`[index] Publishing target: ${event.target}...`);
                }
                return;
            case "recipe-save":
                return;
            case "operation-complete":
                return;
            case "operation-failed":
                return;
        }
    };
}

function createJsonReporter(): (event: ProjectIndexingEvent) => void {
    let previousPhase: string | undefined;
    let lastRenderedAt = 0;

    return (event) => {
        if (event.type === "indexing-progress") {
            const now = Date.now();
            const phaseChanged = event.progress.phase !== previousPhase;
            const reachedTotal = event.progress.total !== undefined &&
                event.progress.completed === event.progress.total;

            if (
                !phaseChanged &&
                !reachedTotal &&
                now - lastRenderedAt <
                    INDEXING_PROGRESS_RENDER_INTERVAL_MILLISECONDS
            ) {
                return;
            }
            previousPhase = event.progress.phase;
            lastRenderedAt = now;
        }
        process.stderr.write(`${JSON.stringify(event)}\n`);
    };
}
