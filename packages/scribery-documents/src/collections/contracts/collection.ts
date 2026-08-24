import type { IndexBuildRecord } from "scribery-core";
import type { SupportedEncoding } from "scribery-core";
import type {
    RetrievalContextOptions,
    RetrievalRerankingOptions,
} from "scribery-core";

export interface CollectionSource {
    sourceId: string;
    externalId: string;
    logicalPath: string;
    title: string;
    mediaType: string;
    byteLength: number;
    byteContentHash: string;
    contentFilename: string;
    tags: readonly string[];
    attributes: Readonly<Record<string, string | number | boolean>>;
    originalLocation?: string;
    encoding?: SupportedEncoding;
    createdAt: string;
    updatedAt: string;
}

export interface ActiveCollectionBuild {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    completedAt: string;
}

export interface CollectionManifest {
    schemaVersion: 1;
    collectionId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    sourcesRevision: number;
    builtSourcesRevision?: number;
    activeBuild?: ActiveCollectionBuild;
    sources: readonly CollectionSource[];
}

export interface CollectionDocumentInput {
    externalId: string;
    content: string | Uint8Array;
    logicalPath?: string;
    title?: string;
    mediaType?: string;
    tags?: readonly string[];
    attributes?: Readonly<Record<string, string | number | boolean>>;
    originalLocation?: string;
    encoding?: SupportedEncoding;
}

export interface CollectionBuildOptions {
    maximumChunkSize?: number;
    slidingWindowOverlap?: number;
    maximumEmbeddingInputsPerBatch?: number;
    maximumFileByteLength?: number;
    encodingFallback?: "windows-1251";
    signal?: AbortSignal;
    onProgress?: (progress: CollectionBuildProgress) => void;
}

export interface CollectionBuildProgress {
    phase: "processing" | "embedding" | "finalizing" | "complete";
    completed: number;
    total: number;
    currentSourceId?: string;
    reusedDocuments?: number;
    reusedChunks?: number;
    reusedEmbeddings?: number;
    generatedEmbeddings?: number;
}

export interface CollectionBuildResult {
    collectionId: string;
    databasePath: string;
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    sourceCount: number;
    indexedDocuments: number;
    indexedChunks: number;
    reusedDocuments: number;
    reusedChunks: number;
    reusedEmbeddings: number;
    generatedEmbeddings: number;
    reusedBuild: boolean;
    diagnostics: readonly CollectionBuildDiagnostic[];
}

export interface CollectionBuildDiagnostic {
    sourceId: string;
    logicalPath: string;
    code: string;
    message: string;
}

export interface CollectionSummary {
    collectionId: string;
    name: string;
    sourceCount: number;
    sourcesRevision: number;
    builtSourcesRevision?: number;
    needsBuild: boolean;
    databasePath: string;
    activeBuild?: ActiveCollectionBuild;
}

export interface DeletedCollection {
    collectionId: string;
    name: string;
    databasePath: string;
}

export type SourceTagMutation = "set" | "add" | "remove" | "clear";

export interface CollectionRetrievalScope {
    sourceIds?: readonly string[];
    tags?: readonly string[];
}

export interface CollectionRetrievalRequest {
    query: string;
    scope?: CollectionRetrievalScope;
    limit?: number;
    context?: RetrievalContextOptions;
    rerank?: RetrievalRerankingOptions;
    signal?: AbortSignal;
}

export interface ResolvedCollectionBuild {
    manifest: CollectionManifest;
    build: IndexBuildRecord;
    databasePath: string;
}
