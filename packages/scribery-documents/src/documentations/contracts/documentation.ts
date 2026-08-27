import type { IndexBuildRecord } from "scribery-core";
import type { SupportedEncoding } from "scribery-core";
import type {
    RetrievalContextOptions,
    RetrievalRerankingOptions,
} from "scribery-core";

export interface DocumentationSource {
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

export interface ActiveDocumentationBuild {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    completedAt: string;
}

export interface DocumentationManifest {
    schemaVersion: 1;
    documentationId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    sourcesRevision: number;
    builtSourcesRevision?: number;
    activeBuild?: ActiveDocumentationBuild;
    sources: readonly DocumentationSource[];
}

export interface DocumentationInput {
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

export interface DocumentationBuildOptions {
    maximumChunkSize?: number;
    slidingWindowOverlap?: number;
    maximumEmbeddingInputsPerBatch?: number;
    maximumFileByteLength?: number;
    encodingFallback?: "windows-1251";
    signal?: AbortSignal;
    onProgress?: (progress: DocumentationBuildProgress) => void;
}

export interface DocumentationBuildProgress {
    phase: "processing" | "embedding" | "finalizing" | "complete";
    completed: number;
    total: number;
    currentSourceId?: string;
    reusedDocuments?: number;
    reusedChunks?: number;
    reusedEmbeddings?: number;
    generatedEmbeddings?: number;
}

export interface DocumentationBuildResult {
    documentationId: string;
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
    diagnostics: readonly DocumentationBuildDiagnostic[];
}

export interface DocumentationBuildDiagnostic {
    sourceId: string;
    logicalPath: string;
    code: string;
    message: string;
}

export interface DocumentationSummary {
    documentationId: string;
    name: string;
    sourceCount: number;
    sourcesRevision: number;
    builtSourcesRevision?: number;
    needsBuild: boolean;
    databasePath: string;
    activeBuild?: ActiveDocumentationBuild;
}

export interface DeletedDocumentation {
    documentationId: string;
    name: string;
    databasePath: string;
}

export type SourceTagMutation = "set" | "add" | "remove" | "clear";

export interface DocumentationRetrievalScope {
    sourceIds?: readonly string[];
    tags?: readonly string[];
}

export interface DocumentationRetrievalRequest {
    query: string;
    scope?: DocumentationRetrievalScope;
    limit?: number;
    context?: RetrievalContextOptions;
    rerank?: RetrievalRerankingOptions;
    signal?: AbortSignal;
}

export interface ResolvedDocumentationBuild {
    manifest: DocumentationManifest;
    build: IndexBuildRecord;
    databasePath: string;
}
