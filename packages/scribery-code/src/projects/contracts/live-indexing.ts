import type { SerializedError } from "scribery-core";
import type { ProjectIndexingEvent } from "./project-indexing.js";
import type { ProjectIndexingProvider } from "./indexing-recipe.js";

export type ProjectLiveIndexingPhase =
    | "starting"
    | "pending"
    | "indexing"
    | "ready"
    | "failed"
    | "stopped";

export type ProjectLiveIndexingReason =
    | "initial"
    | "filesystem"
    | "git"
    | "manual";

export interface ProjectLiveIndexingStatus {
    schemaVersion: 1;
    sessionId: string;
    processId: number;
    projectIdentifier: string;
    root: string;
    phase: ProjectLiveIndexingPhase;
    generation: number;
    startedAt: string;
    updatedAt: string;
    reason?: ProjectLiveIndexingReason;
    branch?: string;
    target?: string;
    indexBuildId?: string;
    error?: SerializedError;
}

export interface ProjectLiveIndexingRequest {
    projectReference?: string;
    root: string;
    provider: ProjectIndexingProvider;
    keepReplacedBuilds?: number;
    maximumChunkSize?: number;
    windows1251?: boolean;
    include?: readonly string[];
    exclude?: readonly string[];
    debounceMilliseconds?: number;
    pollIntervalMilliseconds?: number;
    onEvent?: (event: ProjectLiveIndexingEvent) => void;
}

export type ProjectLiveIndexingEvent =
    | {
        type: "status";
        status: ProjectLiveIndexingStatus;
    }
    | {
        type: "indexing";
        event: ProjectIndexingEvent;
    };
