import { basename, resolve } from "node:path";

import type { SelectItem } from "@earendil-works/pi-tui";
import {
    deleteIndexedProject,
    ProjectInspectionService,
    ProjectRetrievalTargetService,
    SqliteStorageProvider,
    type IndexedProjectSummary,
} from "scribery";

import type { ProjectPreference } from "../domain/project-preferences.js";
import type { ProjectPreferenceStore } from "../services/preference-store.js";
import type { TranscriptTone } from "./contracts.js";

export interface ProjectUi {
    append(message: string, tone?: TranscriptTone): void;
    pick(title: string, items: readonly SelectItem[]): Promise<SelectItem | undefined>;
    pickWithDelete(
        title: string,
        items: readonly SelectItem[],
    ): Promise<{
        action: "select" | "delete";
        item: SelectItem;
    } | undefined>;
    input(title: string, label: string, initialValue?: string): Promise<string | undefined>;
    confirm(title: string, defaultYes?: boolean): Promise<boolean>;
    copy(value: string): void;
}

export interface ProjectControllerOptions {
    cwd: string;
    ui: ProjectUi;
    preferences: ProjectPreferenceStore;
    inspection: ProjectInspectionService;
    targets: ProjectRetrievalTargetService;
    projects(): readonly IndexedProjectSummary[];
    activeProject(): IndexedProjectSummary | undefined;
    activePreference(): ProjectPreference | undefined;
    refreshProjects(preferredIdentifier?: string): Promise<void>;
    clearActiveProject(): void;
    liveRunning(): boolean;
}

export class ProjectController {
    readonly #cwd: string;
    readonly #ui: ProjectUi;
    readonly #preferences: ProjectPreferenceStore;
    readonly #inspection: ProjectInspectionService;
    readonly #targets: ProjectRetrievalTargetService;
    readonly #projects: () => readonly IndexedProjectSummary[];
    readonly #activeProject: () => IndexedProjectSummary | undefined;
    readonly #activePreference: () => ProjectPreference | undefined;
    readonly #refreshProjects: (preferredIdentifier?: string) => Promise<void>;
    readonly #clearActiveProject: () => void;
    readonly #liveRunning: () => boolean;

    constructor(options: ProjectControllerOptions) {
        this.#cwd = options.cwd;
        this.#ui = options.ui;
        this.#preferences = options.preferences;
        this.#inspection = options.inspection;
        this.#targets = options.targets;
        this.#projects = options.projects;
        this.#activeProject = options.activeProject;
        this.#activePreference = options.activePreference;
        this.#refreshProjects = options.refreshProjects;
        this.#clearActiveProject = options.clearActiveProject;
        this.#liveRunning = options.liveRunning;
    }

    async select(argument = ""): Promise<void> {
        if (this.#liveRunning() && argument !== "info") {
            this.#ui.append("Stop live indexing with /live stop before switching or forgetting projects.", "warning");
            return;
        }
        await this.#refreshProjects();
        if (argument === "info") {
            this.#ui.append(JSON.stringify({
                ...this.#requiredProject(),
                preference: this.#activePreference() ?? null,
            }, null, 2));
            return;
        }
        if (argument === "forget") {
            const project = this.#requiredProject();
            const name = basename(project.root ?? project.projectIdentifier);
            if (!await this.#ui.confirm(`Forget ${name}? Source files will not be touched.`, false)) return;
            await deleteIndexedProject(project.projectIdentifier);
            await this.#preferences.remove(project.projectIdentifier);
            this.#clearActiveProject();
            await this.#refreshProjects();
            this.#ui.append(`Removed the managed index for ${name}.`, "success");
            return;
        }
        const projects = this.#projects();
        if (projects.length === 0) {
            this.#ui.append("No indexed projects are available. Run /index in a project first.", "warning");
            return;
        }
        const direct = argument
            ? projects.find((project) =>
                project.projectIdentifier === argument ||
                project.root === resolve(argument) ||
                basename(project.root ?? project.projectIdentifier) === argument
            )
            : undefined;
        const selected = direct
            ? { value: direct.projectIdentifier, label: basename(direct.root ?? direct.projectIdentifier) }
            : await this.#ui.pick("Select project", projects.map((project) => ({
                value: project.projectIdentifier,
                label: basename(project.root ?? project.projectIdentifier),
                description: project.latestReadyBuild
                    ? `${project.latestReadyBuild.model} · ${relativeTime(project.latestReadyBuild.completedAt)}`
                    : `${project.buildCount} builds · no ready build`,
            })));
        if (!selected) return;
        await this.#refreshProjects(selected.value);
        this.#ui.append(`Switched to ${basename(this.#activeProject()?.root ?? selected.value)}.`, "success");
    }

    async browseBuilds(): Promise<void> {
        const project = this.#requiredProject();

        while (true) {
            const storage = new SqliteStorageProvider(project.databasePath, {
                readOnly: true,
                immutable: true,
            });
            const builds = await storage.listBuilds().finally(() => storage.close());

            if (builds.length === 0) {
                this.#ui.append("This project has no builds.", "muted");
                return;
            }
            const targetListing = await this.#targets.list(
                project.projectIdentifier,
                this.#cwd,
            );
            const items = builds.map((build) => {
                const protection = buildProtection(
                    targetListing,
                    build.indexBuildId,
                );
                return {
                    value: build.indexBuildId,
                    label: `${build.indexBuildId.slice(0, 12)}  ${build.status}`,
                    description: [
                        build.modelIdentity.model,
                        relativeTime(build.completedAt ?? build.createdAt),
                        protection,
                    ].filter(Boolean).join(" · "),
                };
            });
            const outcome = this.#liveRunning()
                ? await this.#ui.pick("Build history", items).then((item) =>
                    item === undefined
                        ? undefined
                        : { action: "select" as const, item }
                )
                : await this.#ui.pickWithDelete("Build history", items);

            if (outcome === undefined) return;

            const build = builds.find(({ indexBuildId }) =>
                indexBuildId === outcome.item.value
            );
            if (build === undefined) return;

            if (outcome.action === "select") {
                this.#ui.append(JSON.stringify(build, null, 2));
                return;
            }

            const protection = buildProtection(targetListing, build.indexBuildId);
            if (protection !== undefined) {
                this.#ui.append(
                    `Build ${build.indexBuildId.slice(0, 12)} is ${protection} and cannot be deleted.`,
                    "warning",
                );
                continue;
            }
            if (!await this.#ui.confirm(
                `Delete build ${build.indexBuildId.slice(0, 12)}? Indexed artifacts will be removed; source files will not be touched.`,
                false,
            )) {
                continue;
            }

            const deleted = await this.#targets.deleteBuild(
                project.projectIdentifier,
                build.indexBuildId,
                this.#cwd,
            );
            await this.#refreshProjects(project.projectIdentifier);
            this.#ui.append(
                `Deleted build ${build.indexBuildId.slice(0, 12)}: ` +
                    `${deleted.deletedChunks} chunks and ` +
                    `${deleted.deletedEmbeddings} embeddings removed.`,
                "success",
            );
        }
    }

    async manageTargets(): Promise<void> {
        if (this.#liveRunning()) {
            this.#ui.append("Live mode owns the active retrieval target. Stop it before changing targets manually.", "warning");
            return;
        }
        const project = this.#requiredProject();
        const listing = await this.#targets.list(project.projectIdentifier, this.#cwd);
        const targets = Array.isArray(listing.targets) ? listing.targets.filter(isRecord) : [];
        const active = isRecord(listing.active) ? listing.active : undefined;
        const selection = await this.#ui.pick("Retrieval targets", [
            {
                value: "__deactivate",
                label: active === undefined
                    ? "● Retrieval inactive"
                    : "○ Deactivate retrieval",
                description: active === undefined
                    ? "No build is selected"
                    : "Required before removing the active target or build",
            },
            ...targets.map((target) => ({
                value: String(target.name),
                label: `${target.active === true ? "●" : "○"} ${String(target.name)}`,
                description: String(target.indexBuildId ?? ""),
            })),
        ]);
        if (!selection) return;
        if (selection.value === "__deactivate") {
            if (active === undefined) {
                this.#ui.append("Project retrieval is already inactive.", "muted");
                return;
            }
            await this.#targets.deactivate(
                project.projectIdentifier,
                this.#cwd,
            );
            await this.#refreshProjects(project.projectIdentifier);
            this.#ui.append(
                "Deactivated project retrieval. Explicit build inspection remains available.",
                "success",
            );
            return;
        }
        const action = await this.#ui.pick(selection.label, [
            { value: "switch", label: "Make active" },
            { value: "rename", label: "Rename" },
            { value: "remove", label: "Remove target" },
        ]);
        if (!action) return;
        if (action.value === "switch") {
            await this.#targets.switchTarget(project.projectIdentifier, selection.value, this.#cwd);
            await this.#refreshProjects(project.projectIdentifier);
            this.#ui.append(`Activated target ${selection.value}.`, "success");
        } else if (action.value === "rename") {
            const next = (await this.#ui.input(`Rename ${selection.value}`, "New name", selection.value))?.trim();
            if (next && next !== selection.value) {
                await this.#targets.renameTarget(project.projectIdentifier, selection.value, next, this.#cwd);
                await this.#refreshProjects(project.projectIdentifier);
                this.#ui.append(`Renamed ${selection.value} to ${next}.`, "success");
            }
        } else if (action.value === "remove" && await this.#ui.confirm(`Remove target ${selection.value}?`)) {
            await this.#targets.removeTarget(project.projectIdentifier, selection.value, this.#cwd);
            await this.#refreshProjects(project.projectIdentifier);
            this.#ui.append(`Removed target ${selection.value}.`, "success");
        }
    }

    async inspectChunks(argument: string): Promise<void> {
        const project = this.#requiredProject();
        const path = argument || await this.#ui.input("Inspect indexed chunks", "Relative path");
        if (!path?.trim()) return;
        const result = await this.#inspection.chunks({
            projectReference: project.projectIdentifier,
            path: path.trim(),
        }, this.#cwd);
        const lines = result.chunks.chunks.map((chunk, index) => [
            `Chunk ${index + 1} · lines ${chunk.metadata.startLine}–${chunk.metadata.endLine}`,
            chunk.content,
        ].join("\n"));
        this.#ui.append(`${path.trim()} · build ${result.indexBuildId.slice(0, 12)}\n\n${lines.join("\n\n")}`);
    }

    async showMcp(): Promise<void> {
        const project = this.#requiredProject();
        const profile = this.#activePreference()?.profile;
        const configuration = JSON.stringify({
            scribery: {
                type: "stdio",
                command: "scribery-mcp",
                args: [
                    "--project",
                    project.root ?? project.projectIdentifier,
                    ...(profile ? ["--profile", profile] : []),
                    "--tools",
                    "vector_search",
                ],
            },
        }, null, 2);
        const action = await this.#ui.pick("MCP configuration", [
            { value: "copy", label: "Copy JSON", description: "Use terminal clipboard support" },
            { value: "print", label: "Print JSON", description: "Leave configuration in scrollback" },
        ]);
        if (action?.value === "copy") {
            this.#ui.copy(configuration);
            this.#ui.append("Copied MCP configuration to the clipboard.", "success");
        } else if (action?.value === "print") {
            this.#ui.append(configuration);
        }
    }

    #requiredProject(): IndexedProjectSummary {
        const project = this.#activeProject();
        if (!project) throw new Error("No indexed project is active");
        return project;
    }
}

function relativeTime(value?: string): string {
    if (!value) return "unknown time";
    const milliseconds = Date.now() - new Date(value).getTime();
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildProtection(
    listing: Readonly<Record<string, unknown>>,
    indexBuildId: string,
): string | undefined {
    const active = isRecord(listing.active) ? listing.active : undefined;
    if (active?.indexBuildId === indexBuildId) return "active";

    const targets = Array.isArray(listing.targets)
        ? listing.targets.filter(isRecord)
        : [];

    for (const target of targets) {
        const name = String(target.name ?? "unnamed");
        if (target.indexBuildId === indexBuildId) return `used by target ${name}`;
        if (
            Array.isArray(target.retainedBuildIds) &&
            target.retainedBuildIds.includes(indexBuildId)
        ) {
            return `retained by target ${name}`;
        }
    }

    return undefined;
}
