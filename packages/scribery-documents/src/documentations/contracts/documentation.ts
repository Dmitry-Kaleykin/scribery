import type { IndexBuildRecord, SupportedEncoding } from "scribery-core";
import type {
    RetrievalContextOptions,
    RetrievalRerankingOptions,
} from "scribery-core";

export type DocumentationAttributeValue = string | number | boolean;

export interface ManagedDocumentationSource {
    kind: "managed";
    sourceId: string;
    externalId: string;
    logicalPath: string;
    title: string;
    mediaType: string;
    byteLength: number;
    byteContentHash: string;
    contentFilename: string;
    tags: readonly string[];
    attributes: Readonly<Record<string, DocumentationAttributeValue>>;
    originalLocation?: string;
    encoding?: SupportedEncoding;
    createdAt: string;
    updatedAt: string;
}

export interface DirectoryDocumentationSource {
    kind: "directory";
    sourceId: string;
    root: string;
    mountPath: string;
    include: readonly string[];
    exclude: readonly string[];
    useGitignore: boolean;
    includeHidden: boolean;
    maximumFileByteLength?: number;
    tags: readonly string[];
    attributes: Readonly<Record<string, DocumentationAttributeValue>>;
    createdAt: string;
    updatedAt: string;
}

export type DocumentationSourceDefinition =
    | ManagedDocumentationSource
    | DirectoryDocumentationSource;

export interface IndexedDocumentationSource {
    sourceId: string;
    sourceDefinitionId: string;
    logicalPath: string;
    title: string;
    byteLength: number;
    byteContentHash: string;
    tags: readonly string[];
    attributes: Readonly<Record<string, DocumentationAttributeValue>>;
    originalLocation?: string;
    mediaType?: string;
    encoding?: SupportedEncoding;
}

export interface ActiveDocumentationBuild {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    configurationRevision: number;
    indexedSources: readonly IndexedDocumentationSource[];
    completedAt: string;
}

export interface DocumentationManifest {
    schemaVersion: 2;
    documentationId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    configurationRevision: number;
    sourceDefinitions: readonly DocumentationSourceDefinition[];
    activeBuild?: ActiveDocumentationBuild;
}

export interface DocumentationInput {
    externalId: string;
    content: string | Uint8Array;
    logicalPath?: string;
    title?: string;
    mediaType?: string;
    tags?: readonly string[];
    attributes?: Readonly<Record<string, DocumentationAttributeValue>>;
    originalLocation?: string;
    encoding?: SupportedEncoding;
}

export interface DocumentationDirectoryInput {
    root: string;
    mountPath?: string;
    include?: readonly string[];
    exclude?: readonly string[];
    useGitignore?: boolean;
    includeHidden?: boolean;
    maximumFileByteLength?: number;
    tags?: readonly string[];
    attributes?: Readonly<Record<string, DocumentationAttributeValue>>;
}

export interface DocumentationIndexOptions {
    maximumChunkSize?: number;
    slidingWindowOverlap?: number;
    maximumEmbeddingInputsPerBatch?: number;
    maximumFileByteLength?: number;
    encodingFallback?: "windows-1251";
    signal?: AbortSignal;
    onProgress?: (progress: DocumentationIndexProgress) => void;
}

export interface DocumentationIndexProgress {
    phase: "processing" | "embedding" | "finalizing" | "complete";
    completed: number;
    total: number;
    currentPath?: string;
    reusedDocuments?: number;
    reusedChunks?: number;
    reusedEmbeddings?: number;
    generatedEmbeddings?: number;
}

export interface DocumentationIndexResult {
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
    diagnostics: readonly DocumentationIndexDiagnostic[];
}

export interface DocumentationIndexDiagnostic {
    sourceId: string;
    logicalPath: string;
    code: string;
    message: string;
}

export interface DocumentationSummary {
    documentationId: string;
    name: string;
    sourceDefinitionCount: number;
    indexedSourceCount: number;
    configurationRevision: number;
    indexedConfigurationRevision?: number;
    needsIndex: boolean;
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
