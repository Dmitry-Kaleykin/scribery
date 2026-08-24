import type { FileTrait } from "../../classification/index.js";
import type { DiscoveryOptions } from "../../discovery/index.js";
import type {
    SupportedEncoding,
    Windows1251EncodingLabel,
} from "../../shared/index.js";
import type { CodeOnlyIndexingPolicyOptions } from "./policy.js";

export interface EncodingPathRule {
    pattern: string;
    encoding: SupportedEncoding;
}

export interface IndexingConfiguration {
    root: string;
    repositoryIdentity?: string;
    allowDirty?: boolean;
    include?: readonly string[];
    exclude?: readonly string[];
    includeHidden?: boolean;
    maximumFileByteLength?: number;
    maximumChunkSize?: number;
    maximumEmbeddingInputsPerBatch?: number;
    encodingFallback?: Windows1251EncodingLabel;
    encodingOverrides?: readonly EncodingPathRule[];
    excludedTraits?: readonly FileTrait[];
    onProgress?: (progress: IndexingProgress) => void;
    signal?: AbortSignal;
}

export type IndexingProgressPhase =
    | "source-inspection"
    | "discovery"
    | "preparing-build"
    | "processing"
    | "embedding"
    | "storage"
    | "finalizing"
    | "complete";

export type IndexingProgressActivity = "chunking";

export interface IndexingProgress {
    phase: IndexingProgressPhase;
    activity?: IndexingProgressActivity;
    completed?: number;
    total?: number;
    currentPath?: string;
    discoveredFiles?: number;
    discoveredBytes?: number;
    queuedChunks?: number;
    reusedDocuments?: number;
    reusedChunks?: number;
    reusedEmbeddings?: number;
    generatedEmbeddings?: number;
    reusedBuild?: boolean;
}

export interface IndexingDiagnostic {
    stage: "discovery" | "policy" | "processing";
    path: string;
    sourceId?: string;
    code: string;
    message: string;
}

export interface IndexingResult {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    discoveredFiles: number;
    indexedDocuments: number;
    indexedChunks: number;
    diagnostics: readonly IndexingDiagnostic[];
    reusedDocuments: number;
    reusedChunks: number;
    reusedEmbeddings: number;
    generatedEmbeddings: number;
    reused: boolean;
}

export interface IndexingCoordinatorOptions {
    discoveryOptions?: Omit<DiscoveryOptions, "signal">;
    policyOptions?: CodeOnlyIndexingPolicyOptions;
}
