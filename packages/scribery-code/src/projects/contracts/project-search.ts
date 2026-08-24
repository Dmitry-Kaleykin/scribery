import type {
    RetrievalContextOptions,
    RetrievalRerankingFailureMode,
    RetrievalResult,
} from "scribery-core";
import type {
    ResolvedProjectRetrievalSelection,
} from "./retrieval-target.js";

export interface ProjectSearchRerankingOptions {
    enabled?: boolean;
    candidateLimit?: number;
    failureMode?: RetrievalRerankingFailureMode;
}

export interface ProjectSearchRequest {
    query: string;
    projectReference?: string;
    indexBuildId?: string;
    profile?: string;
    limit?: number;
    language?: string;
    context?: RetrievalContextOptions;
    reranking?: ProjectSearchRerankingOptions;
    signal?: AbortSignal;
}

export interface ProjectSearchResult {
    projectIdentifier: string;
    root?: string;
    databasePath: string;
    indexBuildId: string;
    retrievalSelection: ResolvedProjectRetrievalSelection | {
        type: "requested-build";
        indexBuildId: string;
    };
    resultCount: number;
    results: readonly RetrievalResult[];
}
