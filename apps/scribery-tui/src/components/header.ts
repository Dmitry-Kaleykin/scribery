import { basename } from "node:path";

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type {
    IndexedProjectSummary,
    ProjectLiveIndexingStatus,
} from "scribery";

import type { ProjectPreference } from "../domain/project-preferences.js";
import { colors } from "../theme.js";

export interface HeaderState {
    project?: IndexedProjectSummary;
    preference?: ProjectPreference;
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
        const build = this.#state.project?.latestReadyBuild?.indexBuildId.slice(0, 12) ?? "none";
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
            ? `${this.#state.preference.profile} · ${this.#state.preference.preset} · ${this.#state.preference.target}`
            : "profile and preset not selected";
        const liveContext = live !== undefined && live.phase !== "stopped"
            ? ` · ${live.target ?? live.branch ?? "live"}`
            : "";
        return [
            truncateToWidth(`${colors.bold(colors.accent("Scribery"))}  ${colors.muted("local retrieval")}`, width),
            truncateToWidth(`${colors.muted("Project")} ${colors.bold(projectName)}  ${colors.muted("Build")} ${build}  ${colors.muted("Status")} ${status}`, width),
            truncateToWidth(`${colors.muted("Config ")} ${configuration}${liveContext}`, width),
            colors.muted("─".repeat(Math.max(0, width))),
        ];
    }

    invalidate(): void {}
}
