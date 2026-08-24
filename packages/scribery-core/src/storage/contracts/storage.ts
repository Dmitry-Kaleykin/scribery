import type {
    ChunkMetadata,
    DocumentMetadata,
    EmbeddingModelIdentity,
    FilterableMetadataField,
    FilterMetadata,
} from "../../metadata/index.js";
import type { SupportedEncoding } from "../../shared/index.js";
import type {
    SourceProvenance,
} from "../../sources/contracts/source.js";

export type IndexBuildStatus = "building" | "ready" | "failed" | "cancelled";

export interface IndexBuildRecord {
    indexBuildId: string;
    repositoryId: string;
    snapshotId: string;
    sourceIdentity: string;
    sourceProvenance?: SourceProvenance;
    configurationHash: string;
    artifactCompatibilityHash?: string;
    modelIdentity: EmbeddingModelIdentity;
    status: IndexBuildStatus;
    createdAt: string;
    completedAt?: string;
}

export interface StoredDocument {
    metadata: DocumentMetadata;
    content: string;
}

export interface StoredChunk {
    metadata: ChunkMetadata;
    content: string;
}

export interface StoredEmbedding {
    embeddingId: string;
    inputHash: string;
    modelIdentity: EmbeddingModelIdentity;
    vector: Float32Array;
}

export interface ChunkEmbeddingWrite {
    documentId: string;
    chunk: StoredChunk;
    embedding: StoredEmbedding;
    filterMetadata: FilterMetadata;
}

export interface StorageFilterCondition {
    field: FilterableMetadataField;
    operator: "equals" | "in";
    value: string | number | boolean | readonly (string | number | boolean)[];
}

export interface VectorSearchRequest {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    vector: Float32Array;
    modelIdentity: EmbeddingModelIdentity;
    filters?: readonly StorageFilterCondition[];
    limit: number;
}

export interface VectorSearchResult {
    score: number;
    document: StoredDocument;
    chunk: StoredChunk;
    filterMetadata: FilterMetadata;
}

export interface ChunkNeighborhoodRequest {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    documentId: string;
    anchorChunkId: string;
    beforeChunks: number;
    afterChunks: number;
}

export interface ChunkNeighborhood {
    before: readonly StoredChunk[];
    after: readonly StoredChunk[];
}

export interface DocumentChunksRequest {
    indexBuildId: string;
    path: string;
}

export interface DocumentChunks {
    document: StoredDocument;
    chunks: readonly StoredChunk[];
}

export interface ReuseDocumentArtifactsRequest {
    targetIndexBuildId: string;
    documentId: string;
    fileRevisionId: string;
    encoding: SupportedEncoding;
    language: string;
    format: string;
    parserId?: string;
    chunkingIdentity: string;
}

export interface ReuseDocumentArtifactsCandidate {
    documentId: string;
    fileRevisionId: string;
    compatibleEncodings: readonly SupportedEncoding[];
    language: string;
    format: string;
    parserId?: string;
    chunkingIdentity: string;
}

export interface ReuseDocumentArtifactsBatchRequest {
    targetIndexBuildId: string;
    candidates: readonly ReuseDocumentArtifactsCandidate[];
}

export interface ReusedDocumentArtifacts {
    sourceIndexBuildId: string;
    documentId: string;
    chunkCount: number;
}

export interface ChunkEmbeddingReferenceWrite {
    documentId: string;
    chunk: StoredChunk;
    embeddingId: string;
    inputHash: string;
    filterMetadata: FilterMetadata;
}

export interface ReusedChunkEmbedding {
    documentId: string;
    chunkId: string;
    embeddingId: string;
}

export interface DeletedIndexBuild {
    indexBuildId: string;
    deletedDocuments: number;
    deletedMemberships: number;
    deletedChunks: number;
    deletedEmbeddings: number;
}

export interface StorageProvider {
    beginBuild(record: IndexBuildRecord): Promise<void>;
    putDocument(indexBuildId: string, document: StoredDocument): Promise<void>;
    putChunkEmbedding(
        indexBuildId: string,
        documentId: string,
        chunk: StoredChunk,
        embedding: StoredEmbedding,
        filterMetadata: FilterMetadata,
    ): Promise<void>;
    putChunkEmbeddings(
        indexBuildId: string,
        writes: readonly ChunkEmbeddingWrite[],
    ): Promise<void>;
    setBuildStatus(
        indexBuildId: string,
        status: Exclude<IndexBuildStatus, "building">,
        completedAt: string,
    ): Promise<void>;
    getBuild(indexBuildId: string): Promise<IndexBuildRecord | undefined>;
    listBuilds(): Promise<readonly IndexBuildRecord[]>;
    deleteBuild(indexBuildId: string): Promise<DeletedIndexBuild>;
    reuseDocumentArtifacts(
        request: ReuseDocumentArtifactsRequest,
    ): Promise<ReusedDocumentArtifacts | undefined>;
    reuseDocumentArtifactsMany(
        request: ReuseDocumentArtifactsBatchRequest,
    ): Promise<readonly ReusedDocumentArtifacts[]>;
    reuseChunkEmbeddings(
        indexBuildId: string,
        writes: readonly ChunkEmbeddingReferenceWrite[],
    ): Promise<readonly ReusedChunkEmbedding[]>;
    vectorSearch(request: VectorSearchRequest): Promise<readonly VectorSearchResult[]>;
    getChunkNeighborhood(
        request: ChunkNeighborhoodRequest,
    ): Promise<ChunkNeighborhood>;
    getDocumentChunks(
        request: DocumentChunksRequest,
    ): Promise<DocumentChunks | undefined>;
    close(): Promise<void>;
}
