import type {
    DocumentChunks,
} from "scribery-core";
import type {
    ResolvedProjectRetrievalSelection,
} from "./retrieval-target.js";

export interface ProjectChunkInspectionRequest {
    path: string;
    projectReference?: string;
    indexBuildId?: string;
}

export interface ProjectChunkInspectionResult {
    projectIdentifier: string;
    root?: string;
    databasePath: string;
    indexBuildId: string;
    retrievalSelection: ResolvedProjectRetrievalSelection | {
        type: "requested-build";
        indexBuildId: string;
    };
    chunks: DocumentChunks;
}
