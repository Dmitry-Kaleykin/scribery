import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
    EmbeddingInput,
    EmbeddingProvider,
    EmbeddingResult,
} from "../../embeddings/index.js";
import {
    METADATA_SCHEMA_VERSION,
    hashText,
    type EmbeddingModelIdentity,
} from "../../metadata/index.js";
import {
    RerankingError,
    type RerankingProvider,
} from "../../reranking/index.js";
import type {
    ChunkNeighborhood,
    ChunkNeighborhoodRequest,
    DocumentChunks,
    DocumentChunksRequest,
    IndexBuildRecord,
    ReuseDocumentArtifactsRequest,
    ReusedDocumentArtifacts,
    StorageProvider,
    StoredChunk,
    StoredDocument,
    StoredEmbedding,
    VectorSearchRequest,
    VectorSearchResult,
} from "../../storage/index.js";
import { RetrievalError, SemanticRetriever } from "../index.js";

const model: EmbeddingModelIdentity = {
    provider: "retrieval-reranking-fixture",
    model: "static-v1",
    dimensions: 2,
    metric: "cosine",
    embeddingSuffix: "<|endoftext|>",
};

describe("semantic retrieval reranking", () => {
    it("reranks over-fetched candidates before selecting and expanding context", async () => {
        const storage = new RetrievalFixtureStorage();
        const embeddingProvider = new StaticEmbeddingProvider();
        const retriever = new SemanticRetriever(
            storage,
            embeddingProvider,
            new ScoredFixtureReranker(),
        );
        const results = await retriever.retrieve({
            repositoryId: "repository",
            snapshotId: "snapshot",
            indexBuildId: "build",
            query: "find target",
            filters: [{ field: "language", operator: "equals", value: "typescript" }],
            limit: 2,
            rerank: { candidateLimit: 3 },
            context: {},
        });

        assert.equal(storage.vectorRequest?.limit, 3);
        assert.deepEqual(results.map(({ path }) => path), [
            "src/third.ts",
            "src/second.ts",
        ]);
        assert.deepEqual(results.map(({ score }) => score), [0.9, 0.8]);
        assert.deepEqual(results.map(({ semanticScore }) => semanticScore), [0.7, 0.8]);
        assert.deepEqual(results.map(({ rerankScore }) => rerankScore), [0.9, 0.8]);
        assert.deepEqual(storage.neighborhoodAnchors, ["chunk-third", "chunk-second"]);
        assert.deepEqual(storage.vectorRequest?.filters, [
            { field: "language", operator: "equals", value: "typescript" },
        ]);
        assert.equal(
            embeddingProvider.inputs[0]?.text,
            "find target<|endoftext|>",
        );
    });

    it("uses strict failure by default and supports explicit semantic fallback", async () => {
        const storage = new RetrievalFixtureStorage();
        const retriever = new SemanticRetriever(
            storage,
            new StaticEmbeddingProvider(),
            new FailingFixtureReranker(),
        );

        await assert.rejects(
            retriever.retrieve({
                repositoryId: "repository",
                snapshotId: "snapshot",
                indexBuildId: "build",
                query: "find target",
                limit: 2,
                rerank: { candidateLimit: 3 },
            }),
            (error: unknown) =>
                error instanceof RetrievalError &&
                error.code === "reranking-failed",
        );

        const fallback = await retriever.retrieve({
            repositoryId: "repository",
            snapshotId: "snapshot",
            indexBuildId: "build",
            query: "find target",
            limit: 2,
            rerank: {
                candidateLimit: 3,
                failureMode: "use-semantic-order",
            },
        });

        assert.deepEqual(fallback.map(({ path }) => path), [
            "src/first.ts",
            "src/second.ts",
        ]);
        assert.ok(fallback.every(({ rerankScore }) => rerankScore === undefined));
    });

    it("rejects reranking when no provider is configured", async () => {
        const retriever = new SemanticRetriever(
            new RetrievalFixtureStorage(),
            new StaticEmbeddingProvider(),
        );

        await assert.rejects(
            retriever.retrieve({
                repositoryId: "repository",
                snapshotId: "snapshot",
                indexBuildId: "build",
                query: "find target",
                rerank: {},
            }),
            (error: unknown) =>
                error instanceof RetrievalError &&
                error.code === "invalid-request",
        );
    });
});

class StaticEmbeddingProvider implements EmbeddingProvider {
    readonly identity = model;
    readonly maximumInputs = 16;
    readonly maximumCharacters = 10_000;
    inputs: readonly EmbeddingInput[] = [];

    async embed(inputs: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]> {
        this.inputs = inputs;
        return inputs.map(({ id }) => ({ id, vector: Float32Array.of(1, 0) }));
    }
}

class ScoredFixtureReranker implements RerankingProvider {
    readonly identity = { provider: "fixture", model: "scored-v1" };
    readonly maximumCandidates = 16;
    readonly maximumCharacters = 100_000;

    async rerank(request: Parameters<RerankingProvider["rerank"]>[0]) {
        return request.candidates.map(({ id, content }) => ({
            id,
            score: content.includes("third")
                ? 0.9
                : content.includes("second") ? 0.8 : 0.1,
        }));
    }
}

class FailingFixtureReranker implements RerankingProvider {
    readonly identity = { provider: "fixture", model: "failing-v1" };
    readonly maximumCandidates = 16;
    readonly maximumCharacters = 100_000;

    async rerank(): Promise<never> {
        throw new RerankingError("provider-unavailable", "fixture failure");
    }
}

class RetrievalFixtureStorage implements StorageProvider {
    readonly results = [
        createVectorResult("first", 0.9),
        createVectorResult("second", 0.8),
        createVectorResult("third", 0.7),
    ];
    vectorRequest: VectorSearchRequest | undefined;
    readonly neighborhoodAnchors: string[] = [];

    async beginBuild(_record: IndexBuildRecord): Promise<void> {}
    async putDocument(
        _indexBuildId: string,
        _document: StoredDocument,
    ): Promise<void> {}
    async putChunkEmbedding(
        _indexBuildId: string,
        _documentId: string,
        _chunk: StoredChunk,
        _embedding: StoredEmbedding,
        _filterMetadata: Parameters<StorageProvider["putChunkEmbedding"]>[4],
    ): Promise<void> {}
    async putChunkEmbeddings(
        _indexBuildId: string,
        _writes: Parameters<StorageProvider["putChunkEmbeddings"]>[1],
    ): Promise<void> {}
    async setBuildStatus(
        _indexBuildId: string,
        _status: "ready" | "failed" | "cancelled",
        _completedAt: string,
    ): Promise<void> {}
    async getBuild(): Promise<IndexBuildRecord> {
        return {
            indexBuildId: "build",
            repositoryId: "repository",
            snapshotId: "snapshot",
            sourceIdentity: "fixture",
            configurationHash: hashText("configuration"),
            modelIdentity: model,
            status: "ready",
            createdAt: new Date(0).toISOString(),
            completedAt: new Date(1).toISOString(),
        };
    }
    async listBuilds(): Promise<readonly IndexBuildRecord[]> {
        return [await this.getBuild()];
    }
    async deleteBuild(
        indexBuildId: string,
    ): Promise<Awaited<ReturnType<StorageProvider["deleteBuild"]>>> {
        return {
            indexBuildId,
            deletedDocuments: 0,
            deletedMemberships: 0,
            deletedChunks: 0,
            deletedEmbeddings: 0,
        };
    }
    async reuseDocumentArtifacts(
        _request: ReuseDocumentArtifactsRequest,
    ): Promise<ReusedDocumentArtifacts | undefined> {
        return undefined;
    }
    async reuseDocumentArtifactsMany(
        _request: Parameters<StorageProvider["reuseDocumentArtifactsMany"]>[0],
    ): Promise<readonly ReusedDocumentArtifacts[]> {
        return [];
    }
    async reuseChunkEmbeddings(): Promise<[]> {
        return [];
    }
    async vectorSearch(
        request: VectorSearchRequest,
    ): Promise<readonly VectorSearchResult[]> {
        this.vectorRequest = request;
        return this.results.slice(0, request.limit);
    }
    async getChunkNeighborhood(
        request: ChunkNeighborhoodRequest,
    ): Promise<ChunkNeighborhood> {
        this.neighborhoodAnchors.push(request.anchorChunkId);
        return { before: [], after: [] };
    }
    async getDocumentChunks(
        _request: DocumentChunksRequest,
    ): Promise<DocumentChunks | undefined> {
        return undefined;
    }
    async close(): Promise<void> {}
}

function createVectorResult(name: string, score: number): VectorSearchResult {
    const content = `export const ${name} = true;\n`;
    const documentId = `document-${name}`;
    const chunkId = `chunk-${name}`;

    return {
        score,
        document: {
            content,
            metadata: {
                schemaVersion: METADATA_SCHEMA_VERSION,
                documentId,
                fileRevisionId: `revision-${name}`,
                path: `src/${name}.ts`,
                filename: `${name}.ts`,
                extension: "ts",
                byteLength: content.length,
                byteContentHash: hashText(content),
                decodedContentHash: hashText(content),
                contentKind: "text",
                format: "typescript",
                language: "typescript",
                encoding: "utf-8",
                traits: [],
                classificationConfidence: 1,
            },
        },
        chunk: {
            content,
            metadata: {
                schemaVersion: METADATA_SCHEMA_VERSION,
                documentId,
                chunkId,
                fileRevisionId: `revision-${name}`,
                index: 0,
                contentHash: hashText(content),
                startOffset: 0,
                endOffset: content.length,
                startLine: 1,
                endLine: 1,
                chunkingStrategy: "cast",
                chunkingIdentity: "cast-v1:100",
            },
        },
        filterMetadata: { path: `src/${name}.ts`, language: "typescript" },
    };
}
