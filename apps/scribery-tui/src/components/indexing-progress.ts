import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { IndexingProgress } from "scribery";

import { colors } from "../theme.js";

export type IndexingLiveState =
    | { stage: "provider"; message: string }
    | { stage: "indexing"; progress: IndexingProgress };

const PHASES: Record<IndexingProgress["phase"], string> = {
    "source-inspection": "Inspecting source",
    discovery: "Discovering",
    "preparing-build": "Preparing build",
    processing: "Chunking",
    embedding: "Embedding",
    storage: "Writing index",
    finalizing: "Publishing",
    complete: "Complete",
};

export class IndexingProgressComponent implements Component {
    #state: IndexingLiveState = { stage: "provider", message: "Preparing" };
    #tick = 0;

    setState(state: IndexingLiveState): void {
        this.#state = state;
    }

    tick(): void {
        this.#tick += 1;
    }

    render(width: number): string[] {
        if (this.#state.stage === "provider") {
            const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.#tick % 10];
            return [
                colors.blue("─".repeat(Math.max(0, width))),
                truncateToWidth(`${colors.accent(spinner ?? "·")} ${this.#state.message}`, width),
                colors.blue("─".repeat(Math.max(0, width))),
            ];
        }

        const progress = this.#state.progress;
        const phase = PHASES[progress.phase];
        const total = progress.total;
        const completed = progress.completed ?? 0;
        const numeric = total === undefined ? "" : ` ${completed.toLocaleString()} / ${total.toLocaleString()}`;
        const percentage = total && total > 0 ? Math.min(1, completed / total) : undefined;
        const prefixWidth = visibleWidth(phase) + visibleWidth(numeric) + 3;
        const barWidth = Math.max(8, Math.min(32, width - prefixWidth));
        const fill = percentage === undefined ? this.#tick % barWidth : Math.round(percentage * barWidth);
        const bar = percentage === undefined
            ? Array.from({ length: barWidth }, (_, index) => index === fill ? "█" : "░").join("")
            : `${"█".repeat(fill)}${"░".repeat(Math.max(0, barWidth - fill))}`;
        const current = progress.currentPath
            ? `  ${colors.muted(truncatePath(progress.currentPath, Math.max(8, width - 2)))}`
            : `  ${colors.muted(activityFor(progress))}`;
        const counters = [
            metric(progress.discoveredFiles, "files"),
            metric(progress.queuedChunks, "chunks"),
            metric(progress.reusedDocuments, "documents reused"),
            metric(progress.reusedEmbeddings, "embeddings reused"),
            metric(progress.generatedEmbeddings, "generated"),
        ].filter((value): value is string => value !== undefined).join(" · ");

        return [
            colors.blue("─".repeat(Math.max(0, width))),
            truncateToWidth(`${colors.bold(phase)} ${colors.accent(bar)}${numeric}`, width),
            truncateToWidth(current, width),
            ...(counters ? [truncateToWidth(`  ${colors.dim(counters)}`, width)] : []),
            colors.blue("─".repeat(Math.max(0, width))),
        ];
    }

    invalidate(): void {}
}

function activityFor(progress: IndexingProgress): string {
    if (progress.phase === "complete") return "Ready";
    if (progress.activity === "chunking") return "Processing source files";
    return "Working…";
}

function metric(value: number | undefined, label: string): string | undefined {
    return value === undefined ? undefined : `${value.toLocaleString()} ${label}`;
}

function truncatePath(path: string, width: number): string {
    if (visibleWidth(path) <= width) return path;
    if (width <= 1) return "…";
    return `…${path.slice(-(width - 1))}`;
}
