import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
    ProjectLiveIndexingPhase,
    ProjectLiveIndexingStatus,
} from "../contracts/live-indexing.js";
import {
    managedIndexesDirectory,
    managedProjectDirectory,
} from "../managed/paths.js";

export const LIVE_INDEXING_STATE_FILENAME = "live-indexing.json";
export const LIVE_INDEXING_STATE_VERSION = 1 as const;
export const LIVE_INDEXING_STALE_AFTER_MILLISECONDS = 10_000;

export class ProjectLiveIndexingStateCatalog {
    readonly #indexesDirectory: string;

    constructor(indexesDirectory = managedIndexesDirectory()) {
        this.#indexesDirectory = indexesDirectory;
    }

    async read(
        projectIdentifier: string,
    ): Promise<ProjectLiveIndexingStatus | undefined> {
        try {
            return validateStatus(JSON.parse(await readFile(
                this.#path(projectIdentifier),
                "utf8",
            )) as unknown, projectIdentifier);
        } catch (error: unknown) {
            if (isMissing(error)) return undefined;
            throw error;
        }
    }

    async write(status: ProjectLiveIndexingStatus): Promise<void> {
        const directory = managedProjectDirectory(
            status.projectIdentifier,
            this.#indexesDirectory,
        );
        const path = this.#path(status.projectIdentifier);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await mkdir(directory, { recursive: true });
        await writeFile(
            temporaryPath,
            `${JSON.stringify(validateStatus(
                status,
                status.projectIdentifier,
            ), null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryPath, path);
    }

    async assertReady(
        projectIdentifier: string,
        selectedBuildId: string,
        now = Date.now(),
    ): Promise<void> {
        const status = await this.read(projectIdentifier);
        if (
            status === undefined ||
            status.phase === "stopped" ||
            now - Date.parse(status.updatedAt) >
                LIVE_INDEXING_STALE_AFTER_MILLISECONDS
        ) {
            return;
        }
        if (status.phase !== "ready") {
            throw new Error(
                `Live index for ${status.branch ?? "the current worktree"} is ${status.phase}; retrieval is paused until it is ready`,
            );
        }
        if (status.indexBuildId !== selectedBuildId) {
            throw new Error(
                `Live target ${status.target ?? "for the current worktree"} is not the active retrieval build`,
            );
        }
    }

    #path(projectIdentifier: string): string {
        return join(
            managedProjectDirectory(projectIdentifier, this.#indexesDirectory),
            LIVE_INDEXING_STATE_FILENAME,
        );
    }
}

const PHASES: readonly ProjectLiveIndexingPhase[] = [
    "starting",
    "pending",
    "indexing",
    "ready",
    "failed",
    "stopped",
];

function validateStatus(
    value: unknown,
    projectIdentifier: string,
): ProjectLiveIndexingStatus {
    if (
        !isRecord(value) ||
        value.schemaVersion !== LIVE_INDEXING_STATE_VERSION ||
        value.projectIdentifier !== projectIdentifier ||
        typeof value.sessionId !== "string" ||
        value.sessionId.length === 0 ||
        typeof value.processId !== "number" ||
        !Number.isSafeInteger(value.processId) ||
        value.processId < 1 ||
        typeof value.root !== "string" ||
        !PHASES.includes(value.phase as ProjectLiveIndexingPhase) ||
        typeof value.generation !== "number" ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 0 ||
        typeof value.startedAt !== "string" ||
        !isDate(value.startedAt) ||
        typeof value.updatedAt !== "string" ||
        !isDate(value.updatedAt)
    ) {
        throw new Error("Project live indexing state is invalid");
    }
    return value as unknown as ProjectLiveIndexingStatus;
}

function isDate(value: string): boolean {
    return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
