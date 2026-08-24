import {
    validateChunkMetadata,
    validateDocumentMetadata,
    validateFilterMetadata,
} from "../../../metadata/index.js";
import type {
    ChunkEmbeddingReferenceWrite,
    ChunkEmbeddingWrite,
    ChunkNeighborhood,
    ChunkNeighborhoodRequest,
    DeletedIndexBuild,
    DocumentChunks,
    DocumentChunksRequest,
    IndexBuildRecord,
    ReuseDocumentArtifactsBatchRequest,
    ReuseDocumentArtifactsCandidate,
    ReuseDocumentArtifactsRequest,
    ReusedChunkEmbedding,
    ReusedDocumentArtifacts,
    StorageProvider,
    StoredChunk,
    StoredDocument,
    StoredEmbedding,
    VectorSearchRequest,
    VectorSearchResult,
} from "../../contracts/storage.js";
import { StorageError } from "../../errors/storage-error.js";
import {
    matchesFilters,
    modelIdentityEquals,
    scoreVectors,
} from "../../utils/search.js";
import {
    validateChunkNeighborhoodRequest,
    validateDocumentChunksRequest,
    validateVector,
    validateVectorSearchRequest,
} from "../../utils/validate.js";

interface BuildChunkMembership {
    documentId: string;
    chunkId: string;
    embeddingId: string;
    filterMetadata: Parameters<typeof validateFilterMetadata>[0];
}

interface PlannedDocumentReuse {
    result: ReusedDocumentArtifacts;
    document: StoredDocument;
    memberships: readonly BuildChunkMembership[];
}

export class InMemoryStorageProvider implements StorageProvider {
    readonly #builds = new Map<string, IndexBuildRecord>();
    readonly #documents = new Map<string, StoredDocument>();
    readonly #chunks = new Map<string, StoredChunk>();
    readonly #embeddings = new Map<string, StoredEmbedding>();
    readonly #memberships = new Map<string, BuildChunkMembership[]>();

    async beginBuild(record: IndexBuildRecord): Promise<void> {
        if (this.#builds.has(record.indexBuildId)) {
            throw new StorageError(
                "duplicate-record",
                `Index build ${record.indexBuildId} already exists`,
                { indexBuildId: record.indexBuildId },
            );
        }

        if (record.status !== "building") {
            throw new StorageError(
                "invalid-record",
                "A new index build must start in the building state",
            );
        }

        this.#builds.set(record.indexBuildId, structuredClone(record));
        this.#memberships.set(record.indexBuildId, []);
    }

    async putDocument(
        indexBuildId: string,
        document: StoredDocument,
    ): Promise<void> {
        this.#requireBuilding(indexBuildId);
        validateDocumentMetadata(document.metadata);
        this.#documents.set(
            documentKey(indexBuildId, document.metadata.documentId),
            structuredClone(document),
        );
    }

    async putChunkEmbedding(
        indexBuildId: string,
        documentId: string,
        chunk: StoredChunk,
        embedding: StoredEmbedding,
        filterMetadata: BuildChunkMembership["filterMetadata"],
    ): Promise<void> {
        await this.putChunkEmbeddings(indexBuildId, [{
            documentId,
            chunk,
            embedding,
            filterMetadata,
        }]);
    }

    async putChunkEmbeddings(
        indexBuildId: string,
        writes: readonly ChunkEmbeddingWrite[],
    ): Promise<void> {
        const build = this.#requireBuilding(indexBuildId);

        for (const { documentId, chunk, embedding, filterMetadata } of writes) {
            validateChunkMetadata(chunk.metadata);
            validateFilterMetadata(filterMetadata);
            validateVector(embedding.vector, embedding.modelIdentity);

            if (chunk.metadata.documentId !== documentId) {
                throw new StorageError(
                    "invalid-record",
                    "Chunk attribution does not match its stored document",
                    { documentId, chunkDocumentId: chunk.metadata.documentId },
                );
            }

            if (!modelIdentityEquals(build.modelIdentity, embedding.modelIdentity)) {
                throw new StorageError(
                    "incompatible-model",
                    "Stored embedding model does not match the index build",
                );
            }

            if (!this.#documents.has(documentKey(indexBuildId, documentId))) {
                throw new StorageError(
                    "invalid-record",
                    `Document ${documentId} is not stored`,
                    { documentId },
                );
            }
        }

        for (const { documentId, chunk, embedding, filterMetadata } of writes) {
            this.#chunks.set(
                chunkKey(documentId, chunk.metadata.chunkId),
                structuredClone(chunk),
            );
            this.#embeddings.set(
                embedding.embeddingId,
                cloneEmbedding(embedding),
            );
            this.#memberships.get(indexBuildId)?.push({
                documentId,
                chunkId: chunk.metadata.chunkId,
                embeddingId: embedding.embeddingId,
                filterMetadata: structuredClone(filterMetadata),
            });
        }
    }

    async setBuildStatus(
        indexBuildId: string,
        status: "ready" | "failed" | "cancelled",
        completedAt: string,
    ): Promise<void> {
        const build = this.#requireBuilding(indexBuildId);
        this.#builds.set(indexBuildId, {
            ...build,
            status,
            completedAt,
        });
    }

    async getBuild(indexBuildId: string): Promise<IndexBuildRecord | undefined> {
        const build = this.#builds.get(indexBuildId);
        return build === undefined ? undefined : structuredClone(build);
    }

    async listBuilds(): Promise<readonly IndexBuildRecord[]> {
        return [...this.#builds.values()]
            .map((build) => structuredClone(build))
            .sort(compareBuildsNewestFirst);
    }

    async deleteBuild(indexBuildId: string): Promise<DeletedIndexBuild> {
        const build = this.#builds.get(indexBuildId);

        if (build === undefined) {
            throw new StorageError(
                "build-not-found",
                `Index build ${indexBuildId} does not exist`,
                { indexBuildId },
            );
        }
        if (build.status === "building") {
            throw new StorageError(
                "invalid-record",
                `Building index ${indexBuildId} cannot be deleted`,
                { indexBuildId },
            );
        }

        const deletedMemberships = this.#memberships.get(indexBuildId)?.length ?? 0;
        let deletedDocuments = 0;
        this.#builds.delete(indexBuildId);
        this.#memberships.delete(indexBuildId);

        for (const key of this.#documents.keys()) {
            if (key.startsWith(`${indexBuildId}\0`)) {
                this.#documents.delete(key);
                deletedDocuments += 1;
            }
        }

        const referencedChunks = new Set<string>();
        const referencedEmbeddings = new Set<string>();

        for (const memberships of this.#memberships.values()) {
            for (const membership of memberships) {
                referencedChunks.add(chunkKey(
                    membership.documentId,
                    membership.chunkId,
                ));
                referencedEmbeddings.add(membership.embeddingId);
            }
        }

        let deletedChunks = 0;
        let deletedEmbeddings = 0;

        for (const key of this.#chunks.keys()) {
            if (!referencedChunks.has(key)) {
                this.#chunks.delete(key);
                deletedChunks += 1;
            }
        }
        for (const embeddingId of this.#embeddings.keys()) {
            if (!referencedEmbeddings.has(embeddingId)) {
                this.#embeddings.delete(embeddingId);
                deletedEmbeddings += 1;
            }
        }

        return {
            indexBuildId,
            deletedDocuments,
            deletedMemberships,
            deletedChunks,
            deletedEmbeddings,
        };
    }

    async reuseDocumentArtifacts(
        request: ReuseDocumentArtifactsRequest,
    ): Promise<ReusedDocumentArtifacts | undefined> {
        const [reused] = await this.reuseDocumentArtifactsMany({
            targetIndexBuildId: request.targetIndexBuildId,
            candidates: [{
                documentId: request.documentId,
                fileRevisionId: request.fileRevisionId,
                compatibleEncodings: [request.encoding],
                language: request.language,
                format: request.format,
                ...(request.parserId === undefined
                    ? {}
                    : { parserId: request.parserId }),
                chunkingIdentity: request.chunkingIdentity,
            }],
        });
        return reused;
    }

    async reuseDocumentArtifactsMany(
        request: ReuseDocumentArtifactsBatchRequest,
    ): Promise<readonly ReusedDocumentArtifacts[]> {
        const targetBuild = this.#requireBuilding(request.targetIndexBuildId);
        if (targetBuild.artifactCompatibilityHash === undefined) {
            return [];
        }
        validateReuseCandidates(request.candidates);
        const sourceBuilds = [...this.#builds.values()]
            .filter((build) =>
                build.indexBuildId !== targetBuild.indexBuildId &&
                build.status === "ready" &&
                build.repositoryId === targetBuild.repositoryId &&
                build.artifactCompatibilityHash ===
                    targetBuild.artifactCompatibilityHash &&
                modelIdentityEquals(build.modelIdentity, targetBuild.modelIdentity)
            )
            .sort(compareBuildsNewestFirst);
        const planned: PlannedDocumentReuse[] = [];

        for (const candidate of request.candidates) {
            const reuse = this.#planDocumentReuse(candidate, sourceBuilds);
            if (reuse !== undefined) planned.push(reuse);
        }

        const targetMemberships = this.#memberships.get(targetBuild.indexBuildId);
        if (targetMemberships === undefined) {
            throw new StorageError(
                "storage-failure",
                "Index build has no chunk membership collection",
                { indexBuildId: targetBuild.indexBuildId },
            );
        }

        for (const reuse of planned) {
            const { documentId } = reuse.result;
            if (
                this.#documents.has(documentKey(targetBuild.indexBuildId, documentId)) ||
                targetMemberships.some((membership) =>
                    membership.documentId === documentId
                )
            ) {
                throw new StorageError(
                    "duplicate-record",
                    `Document ${documentId} already belongs to the target build`,
                    { documentId },
                );
            }
        }

        for (const reuse of planned) {
            this.#documents.set(
                documentKey(targetBuild.indexBuildId, reuse.result.documentId),
                structuredClone(reuse.document),
            );
            targetMemberships.push(...structuredClone(reuse.memberships));
        }

        return planned.map(({ result }) => result);
    }

    #planDocumentReuse(
        request: ReuseDocumentArtifactsCandidate,
        sourceBuilds: readonly IndexBuildRecord[],
    ): PlannedDocumentReuse | undefined {
        for (const sourceBuild of sourceBuilds) {
            const sourceDocument = this.#documents.get(
                documentKey(sourceBuild.indexBuildId, request.documentId),
            );
            const sourceMemberships = (
                this.#memberships.get(sourceBuild.indexBuildId) ?? []
            ).filter(({ documentId }) => documentId === request.documentId);

            if (
                sourceDocument?.metadata.fileRevisionId !== request.fileRevisionId ||
                !request.compatibleEncodings.includes(sourceDocument.metadata.encoding) ||
                sourceDocument.metadata.language !== request.language ||
                sourceDocument.metadata.format !== request.format ||
                sourceDocument.metadata.parserId !== request.parserId ||
                sourceMemberships.length === 0
            ) {
                continue;
            }

            let chunkingIdentityMatches = true;

            for (const membership of sourceMemberships) {
                const chunk = this.#chunks.get(chunkKey(
                    membership.documentId,
                    membership.chunkId,
                ));

                if (chunk === undefined || !this.#embeddings.has(membership.embeddingId)) {
                    throw new StorageError(
                        "storage-failure",
                        "Reusable document artifacts are incomplete",
                        { sourceIndexBuildId: sourceBuild.indexBuildId },
                    );
                }

                if (chunk.metadata.chunkingIdentity !== request.chunkingIdentity) {
                    chunkingIdentityMatches = false;
                    break;
                }
            }

            if (!chunkingIdentityMatches) continue;

            return {
                result: {
                    sourceIndexBuildId: sourceBuild.indexBuildId,
                    documentId: request.documentId,
                    chunkCount: sourceMemberships.length,
                },
                document: sourceDocument,
                memberships: sourceMemberships,
            };
        }

        return undefined;
    }

    async reuseChunkEmbeddings(
        indexBuildId: string,
        writes: readonly ChunkEmbeddingReferenceWrite[],
    ): Promise<readonly ReusedChunkEmbedding[]> {
        const build = this.#requireBuilding(indexBuildId);
        const memberships = this.#memberships.get(indexBuildId);

        if (memberships === undefined) {
            throw new StorageError(
                "storage-failure",
                "Index build has no chunk membership collection",
                { indexBuildId },
            );
        }

        const reused: ReusedChunkEmbedding[] = [];

        for (const write of writes) {
            validateChunkMetadata(write.chunk.metadata);
            validateFilterMetadata(write.filterMetadata);

            if (
                write.chunk.metadata.documentId !== write.documentId ||
                !this.#documents.has(documentKey(indexBuildId, write.documentId))
            ) {
                throw new StorageError(
                    "invalid-record",
                    "Reusable chunk attribution does not match a stored document",
                    { documentId: write.documentId },
                );
            }

            const embedding = this.#embeddings.get(write.embeddingId);
            if (embedding === undefined) continue;
            if (
                embedding.inputHash !== write.inputHash ||
                !modelIdentityEquals(embedding.modelIdentity, build.modelIdentity)
            ) {
                throw new StorageError(
                    "storage-failure",
                    "Content-addressed embedding identity is inconsistent",
                    { embeddingId: write.embeddingId },
                );
            }

            this.#chunks.set(
                chunkKey(write.documentId, write.chunk.metadata.chunkId),
                structuredClone(write.chunk),
            );
            memberships.push({
                documentId: write.documentId,
                chunkId: write.chunk.metadata.chunkId,
                embeddingId: write.embeddingId,
                filterMetadata: structuredClone(write.filterMetadata),
            });
            reused.push({
                documentId: write.documentId,
                chunkId: write.chunk.metadata.chunkId,
                embeddingId: write.embeddingId,
            });
        }

        return reused;
    }

    async vectorSearch(
        request: VectorSearchRequest,
    ): Promise<readonly VectorSearchResult[]> {
        const build = this.#builds.get(request.indexBuildId);

        if (
            build === undefined ||
            build.status !== "ready" ||
            build.repositoryId !== request.repositoryId ||
            build.snapshotId !== request.snapshotId
        ) {
            return [];
        }

        if (!modelIdentityEquals(build.modelIdentity, request.modelIdentity)) {
            throw new StorageError(
                "incompatible-model",
                "Search model does not match the index build",
            );
        }

        validateVectorSearchRequest(request);
        validateVector(request.vector, request.modelIdentity);
        const results: VectorSearchResult[] = [];

        for (const membership of this.#memberships.get(request.indexBuildId) ?? []) {
            if (!matchesFilters(membership.filterMetadata, request.filters)) {
                continue;
            }

            const document = this.#documents.get(
                documentKey(request.indexBuildId, membership.documentId),
            );
            const chunk = this.#chunks.get(
                chunkKey(membership.documentId, membership.chunkId),
            );
            const embedding = this.#embeddings.get(membership.embeddingId);

            if (document === undefined || chunk === undefined || embedding === undefined) {
                throw new StorageError(
                    "storage-failure",
                    "Index build contains an incomplete membership",
                );
            }

            results.push({
                score: scoreVectors(
                    request.vector,
                    embedding.vector,
                    request.modelIdentity.metric,
                ),
                document: structuredClone(document),
                chunk: structuredClone(chunk),
                filterMetadata: structuredClone(membership.filterMetadata),
            });
        }

        return results
            .sort((left, right) =>
                right.score - left.score ||
                compareText(
                    left.chunk.metadata.chunkId,
                    right.chunk.metadata.chunkId,
                ) ||
                compareText(
                    left.document.metadata.documentId,
                    right.document.metadata.documentId,
                )
            )
            .slice(0, request.limit);
    }

    async getChunkNeighborhood(
        request: ChunkNeighborhoodRequest,
    ): Promise<ChunkNeighborhood> {
        validateChunkNeighborhoodRequest(request);
        const build = this.#builds.get(request.indexBuildId);

        if (
            build === undefined ||
            build.status !== "ready" ||
            build.repositoryId !== request.repositoryId ||
            build.snapshotId !== request.snapshotId
        ) {
            return { before: [], after: [] };
        }

        const chunks = (this.#memberships.get(request.indexBuildId) ?? [])
            .filter(({ documentId }) => documentId === request.documentId)
            .map(({ documentId, chunkId }) =>
                this.#chunks.get(chunkKey(documentId, chunkId))
            )
            .filter((chunk): chunk is StoredChunk => chunk !== undefined)
            .sort(compareChunksBySourceOrder);
        const anchorIndex = chunks.findIndex(({ metadata }) =>
            metadata.chunkId === request.anchorChunkId
        );

        if (anchorIndex < 0) {
            return { before: [], after: [] };
        }

        return {
            before: structuredClone(chunks.slice(
                Math.max(0, anchorIndex - request.beforeChunks),
                anchorIndex,
            )),
            after: structuredClone(chunks.slice(
                anchorIndex + 1,
                anchorIndex + 1 + request.afterChunks,
            )),
        };
    }

    async getDocumentChunks(
        request: DocumentChunksRequest,
    ): Promise<DocumentChunks | undefined> {
        validateDocumentChunksRequest(request);
        const build = this.#builds.get(request.indexBuildId);

        if (build?.status !== "ready") {
            return undefined;
        }

        const documentEntry = [...this.#documents.entries()].find(
            ([key, document]) =>
                key.startsWith(`${request.indexBuildId}\0`) &&
                document.metadata.path === request.path,
        );

        if (documentEntry === undefined) {
            return undefined;
        }

        const document = documentEntry[1];
        const chunks = (this.#memberships.get(request.indexBuildId) ?? [])
            .filter(({ documentId }) =>
                documentId === document.metadata.documentId
            )
            .map(({ documentId, chunkId }) => {
                const chunk = this.#chunks.get(chunkKey(documentId, chunkId));

                if (chunk === undefined) {
                    throw new StorageError(
                        "storage-failure",
                        "Document chunk membership is incomplete",
                        { documentId, chunkId },
                    );
                }

                return chunk;
            })
            .sort(compareChunksBySourceOrder);

        return structuredClone({ document, chunks });
    }

    async close(): Promise<void> {}

    #requireBuilding(indexBuildId: string): IndexBuildRecord {
        const build = this.#builds.get(indexBuildId);

        if (build === undefined) {
            throw new StorageError(
                "build-not-found",
                `Index build ${indexBuildId} does not exist`,
                { indexBuildId },
            );
        }

        if (build.status !== "building") {
            throw new StorageError(
                "invalid-record",
                `Index build ${indexBuildId} is not writable`,
                { indexBuildId, status: build.status },
            );
        }

        return build;
    }
}

function cloneEmbedding(embedding: StoredEmbedding): StoredEmbedding {
    return {
        ...structuredClone({
            embeddingId: embedding.embeddingId,
            inputHash: embedding.inputHash,
            modelIdentity: embedding.modelIdentity,
        }),
        vector: new Float32Array(embedding.vector),
    };
}

function documentKey(indexBuildId: string, documentId: string): string {
    return `${indexBuildId}\0${documentId}`;
}

function chunkKey(documentId: string, chunkId: string): string {
    return `${documentId}\0${chunkId}`;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareChunksBySourceOrder(left: StoredChunk, right: StoredChunk): number {
    return left.metadata.index - right.metadata.index ||
        compareText(left.metadata.chunkId, right.metadata.chunkId);
}

function compareBuildsNewestFirst(
    left: IndexBuildRecord,
    right: IndexBuildRecord,
): number {
    return compareText(
        right.completedAt ?? right.createdAt,
        left.completedAt ?? left.createdAt,
    ) || compareText(right.createdAt, left.createdAt) ||
        compareText(left.indexBuildId, right.indexBuildId);
}

function validateReuseCandidates(
    candidates: readonly ReuseDocumentArtifactsCandidate[],
): void {
    const documentIds = new Set<string>();

    for (const candidate of candidates) {
        if (
            candidate.documentId.trim().length === 0 ||
            candidate.fileRevisionId.trim().length === 0 ||
            candidate.language.trim().length === 0 ||
            candidate.format.trim().length === 0 ||
            candidate.chunkingIdentity.trim().length === 0 ||
            candidate.compatibleEncodings.length === 0 ||
            candidate.compatibleEncodings.some((encoding) =>
                encoding !== "utf-8" && encoding !== "windows-1251"
            ) ||
            documentIds.has(candidate.documentId)
        ) {
            throw new StorageError(
                "invalid-record",
                "Document artifact reuse candidates are invalid or duplicated",
                { documentId: candidate.documentId },
            );
        }
        documentIds.add(candidate.documentId);
    }
}
