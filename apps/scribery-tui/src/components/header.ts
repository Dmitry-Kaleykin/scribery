import { basename } from "node:path";

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type {
    IndexedProjectSummary,
    ProjectLiveIndexingStatus,
} from "scribery";

import type { ProjectPreference } from "../domain/project-preferences.js";
import type { ActiveIndexSummary } from "../services/active-index-resolver.js";
import { colors } from "../theme.js";

export interface HeaderState {
    project?: IndexedProjectSummary;
    preference?: ProjectPreference;
    activeIndex?: ActiveIndexSummary;
    indexing: boolean;
    live?: ProjectLiveIndexingStatus;
}

export class HeaderComponent implements Component {
    #state: HeaderState = { indexing: false };

    setState(state: HeaderState): void {
        this.#state = state;
    }

    render(width: number): string[] {
        const projectName = this.#state.project?.root
            ? basename(this.#state.project.root)
            : "No indexed project";
        const live = this.#state.live;
        const status = this.#state.indexing
            ? colors.warning("indexing")
            : live?.phase === "pending" || live?.phase === "indexing" || live?.phase === "starting"
                ? colors.warning(`live ${live.phase}`)
                : live?.phase === "ready"
                    ? colors.success("live ready")
                    : live?.phase === "failed"
                        ? colors.warning("live failed")
            : this.#state.project?.latestReadyBuild
                ? colors.success("ready")
                : colors.muted("not indexed");
        const configuration = this.#state.preference
            ? `${this.#state.preference.profile} · ${this.#state.preference.preset}`
            : "profile and preset not selected";
        const activeIndex = this.#state.activeIndex;
        const pendingLiveTarget = live !== undefined && live.phase !== "stopped"
            ? live.target ?? live.branch
            : undefined;
        const liveContext = pendingLiveTarget !== undefined &&
            pendingLiveTarget !== activeIndex?.target
            ? ` · next ${pendingLiveTarget}`
            : "";
        const target = activeIndex?.target ?? "none";
        const build = activeIndex?.indexBuildId.slice(0, 12) ?? "none";
        const indexed = relativeTime(activeIndex?.completedAt);
        return [
            truncateToWidth(`${colors.bold(colors.accent("Scribery"))}  ${colors.muted("local retrieval")}`, width),
            truncateToWidth(`${colors.muted("Project")} ${colors.bold(projectName)}  ${colors.muted("Status")} ${status}`, width),
            truncateToWidth(`${colors.muted("Target")} ${colors.bold(target)}  ${colors.muted("Indexed")} ${indexed}  ${colors.muted("Build")} ${build}`, width),
            truncateToWidth(`${colors.muted("Config")} ${configuration}${liveContext}`, width),
            colors.muted("─".repeat(Math.max(0, width))),
        ];
    }

    invalidate(): void {}
}

function relativeTime(value: string | undefined): string {
    if (value === undefined) return "never";
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "unknown";
    const milliseconds = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
