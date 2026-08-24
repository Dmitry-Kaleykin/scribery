import type {
    EmbeddingProviderDiagnosticResult,
} from "scribery-core";
import type {
    IndexingProgress,
    IndexingResult,
} from "scribery-core";
import type { ConciseIndexingResult } from "../indexing/write-indexing-log.js";
import type { SerializedError } from "scribery-core";
import type {
    ProjectIndexingRecipe,
    ProjectIndexingSettings,
} from "./indexing-recipe.js";
import type { ManagedProjectManifest } from "../managed/manifest.js";

export interface ProjectIndexingRequest extends ProjectIndexingSettings {
    root: string;
    databasePath?: string;
    signal?: AbortSignal;
    onEvent?: (event: ProjectIndexingEvent) => void;
}

interface ProjectIndexingEventBase {
    schemaVersion: 1;
    timestamp: string;
}

export type ProjectIndexingEvent =
    | ProjectIndexingEventBase & {
        type: "provider-diagnostic";
        state: "started";
        model: string;
        dimensions: number;
    }
    | ProjectIndexingEventBase & {
        type: "provider-diagnostic";
        state: "completed";
        result: EmbeddingProviderDiagnosticResult;
    }
    | ProjectIndexingEventBase & {
        type: "indexing-progress";
        progress: IndexingProgress;
    }
    | ProjectIndexingEventBase & {
        type: "target-publication";
        state: "started" | "completed";
        target: string;
        indexBuildId: string;
    }
    | ProjectIndexingEventBase & {
        type: "recipe-save";
        state: "completed";
        projectIdentifier: string;
    }
    | ProjectIndexingEventBase & {
        type: "operation-complete";
        projectIdentifier?: string;
        indexBuildId: string;
    }
    | ProjectIndexingEventBase & {
        type: "operation-failed";
        error: SerializedError;
    };

export interface ProjectIndexingOutcome {
    root: string;
    databasePath: string;
    project?: ManagedProjectManifest;
    result: IndexingResult;
    summary: ConciseIndexingResult;
    retrieval?: Readonly<Record<string, unknown>>;
    recipe?: ProjectIndexingRecipe;
}
