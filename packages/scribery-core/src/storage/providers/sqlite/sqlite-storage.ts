import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
    validateChunkMetadata,
    validateDocumentMetadata,
    validateFilterMetadata,
    type EmbeddingModelIdentity,
    type FilterMetadata,
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

interface ReusableDocumentRow extends Record<string, unknown> {
    ordinal: number;
    source_index_build_id: string;
    document_id: string;
    model_json: string;
    chunk_count: number;
}

interface ChunkRow extends Record<string, unknown> {
    metadata_json: string;
    content: string;
}

interface DocumentRow extends Record<string, unknown> {
    metadata_json: string;
    content: string;
}

interface SearchMembershipRow extends Record<string, unknown> {
    document_id: string;
    chunk_id: string;
    vector_json: string;
    model_json: string;
    filter_json: string;
}

interface RankedMembership {
    score: number;
    documentId: string;
    chunkId: string;
    filterMetadata: FilterMetadata;
}

export interface SqliteStorageProviderOptions {
    readOnly?: boolean;
    immutable?: boolean;
}

interface WritableChunkStatements {
    insertChunk: StatementSync;
    insertEmbedding: StatementSync;
    insertBuildChunk: StatementSync;
}

export class SqliteStorageProvider implements StorageProvider {
    readonly #database: DatabaseSync;
    readonly #insertChunk: StatementSync | undefined;
    readonly #insertEmbedding: StatementSync | undefined;
    readonly #insertBuildChunk: StatementSync | undefined;

    constructor(path: string, options: SqliteStorageProviderOptions = {}) {
        const readOnly = options.readOnly === true;

        if (options.immutable === true && !readOnly) {
            throw new StorageError(
                "storage-failure",
                "Immutable SQLite storage must be opened in read-only mode",
            );
        }

        const location = options.immutable === true
            ? immutableDatabaseUrl(path)
            : path;
        this.#database = new DatabaseSync(location, { readOnly });
        this.#database.exec("PRAGMA foreign_keys = ON;");

        if (readOnly) {
            this.#insertChunk = undefined;
            this.#insertEmbedding = undefined;
            this.#insertBuildChunk = undefined;
        } else {
            this.#database.exec("PRAGMA journal_mode = WAL;");
            this.#createSchema();
            this.#migrateSchema();
            this.#insertChunk = this.#database.prepare(
                `INSERT OR IGNORE INTO chunks(
                    document_id, chunk_id, metadata_json, content
                 ) VALUES (?, ?, ?, ?)`,
            );
            this.#insertEmbedding = this.#database.prepare(
                `INSERT OR IGNORE INTO embeddings(
                    embedding_id, input_hash, model_json, vector_json
                 ) VALUES (?, ?, ?, ?)`,
            );
            this.#insertBuildChunk = this.#database.prepare(
                `INSERT INTO build_chunks(
                    index_build_id, document_id, chunk_id, embedding_id, filter_json
                 ) VALUES (?, ?, ?, ?, ?)`,
            );
        }
    }

    async beginBuild(record: IndexBuildRecord): Promise<void> {
        if (record.status !== "building") {
            throw new StorageError(
                "invalid-record",
                "A new index build must start in the building state",
            );
        }

        this.#transaction(() => {
            this.#database.prepare(
                "INSERT OR IGNORE INTO repositories(repository_id) VALUES (?)",
            ).run(record.repositoryId);
            this.#database.prepare(
                `INSERT OR IGNORE INTO snapshots(
                    snapshot_id, repository_id, source_identity
                ) VALUES (?, ?, ?)`,
            ).run(record.snapshotId, record.repositoryId, record.sourceIdentity);
            this.#database.prepare(
                `INSERT INTO builds(
                    index_build_id, repository_id, snapshot_id, source_identity,
                    source_provenance_json, configuration_hash,
                    artifact_compatibility_hash, model_json, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                record.indexBuildId,
                record.repositoryId,
                record.snapshotId,
                record.sourceIdentity,
                record.sourceProvenance === undefined
                    ? null
                    : JSON.stringify(record.sourceProvenance),
                record.configurationHash,
                record.artifactCompatibilityHash ?? null,
                JSON.stringify(record.modelIdentity),
                record.status,
                record.createdAt,
            );
        });
    }

    async putDocument(
        indexBuildId: string,
        document: StoredDocument,
    ): Promise<void> {
        this.#requireBuilding(indexBuildId);
        validateDocumentMetadata(document.metadata);
        this.#database.prepare(
            `INSERT INTO documents(index_build_id, document_id, metadata_json, content)
             VALUES (?, ?, ?, ?)`,
        ).run(
            indexBuildId,
            document.metadata.documentId,
            JSON.stringify(document.metadata),
            document.content,
        );
    }

    async putChunkEmbedding(
        indexBuildId: string,
        documentId: string,
        chunk: StoredChunk,
        embedding: StoredEmbedding,
        filterMetadata: FilterMetadata,
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
        const statements = this.#requireWritableChunkStatements();
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
        }

        this.#transaction(() => {
            for (const { documentId, chunk, embedding, filterMetadata } of writes) {
                statements.insertChunk.run(
                    documentId,
                    chunk.metadata.chunkId,
                    JSON.stringify(chunk.metadata),
                    chunk.content,
                );
                statements.insertEmbedding.run(
                    embedding.embeddingId,
                    embedding.inputHash,
                    JSON.stringify(embedding.modelIdentity),
                    JSON.stringify([...embedding.vector]),
                );
                statements.insertBuildChunk.run(
                    indexBuildId,
                    documentId,
                    chunk.metadata.chunkId,
                    embedding.embeddingId,
                    JSON.stringify(filterMetadata),
                );
            }
        });
    }

    async setBuildStatus(
        indexBuildId: string,
        status: "ready" | "failed" | "cancelled",
        completedAt: string,
    ): Promise<void> {
        this.#requireBuilding(indexBuildId);
        this.#database.prepare(
            "UPDATE builds SET status = ?, completed_at = ? WHERE index_build_id = ?",
        ).run(status, completedAt, indexBuildId);
    }

    async getBuild(indexBuildId: string): Promise<IndexBuildRecord | undefined> {
        const row = this.#database.prepare(
            "SELECT * FROM builds WHERE index_build_id = ?",
        ).get(indexBuildId);

        return row === undefined ? undefined : buildFromRow(row);
    }

    async listBuilds(): Promise<readonly IndexBuildRecord[]> {
        return this.#database.prepare(
            `SELECT * FROM builds
             ORDER BY created_at DESC, index_build_id ASC`,
        ).all().map(buildFromRow);
    }

    async deleteBuild(indexBuildId: string): Promise<DeletedIndexBuild> {
        const build = await this.getBuild(indexBuildId);

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

        let deletedDocuments = 0;
        let deletedMemberships = 0;
        let deletedChunks = 0;
        let deletedEmbeddings = 0;

        this.#transaction(() => {
            deletedMemberships = Number(this.#database.prepare(
                "DELETE FROM build_chunks WHERE index_build_id = ?",
            ).run(indexBuildId).changes);
            deletedDocuments = Number(this.#database.prepare(
                "DELETE FROM documents WHERE index_build_id = ?",
            ).run(indexBuildId).changes);
            this.#database.prepare(
                "DELETE FROM builds WHERE index_build_id = ?",
            ).run(indexBuildId);
            deletedChunks = Number(this.#database.prepare(
                `DELETE FROM chunks
                 WHERE NOT EXISTS (
                     SELECT 1 FROM build_chunks bc
                     WHERE bc.document_id = chunks.document_id
                       AND bc.chunk_id = chunks.chunk_id
                 )`,
            ).run().changes);
            deletedEmbeddings = Number(this.#database.prepare(
                `DELETE FROM embeddings
                 WHERE NOT EXISTS (
                     SELECT 1 FROM build_chunks bc
                     WHERE bc.embedding_id = embeddings.embedding_id
                 )`,
            ).run().changes);
            this.#database.prepare(
                `DELETE FROM snapshots
                 WHERE NOT EXISTS (
                     SELECT 1 FROM builds
                     WHERE builds.snapshot_id = snapshots.snapshot_id
                 )`,
            ).run();
            this.#database.prepare(
                `DELETE FROM repositories
                 WHERE NOT EXISTS (
                     SELECT 1 FROM snapshots
                     WHERE snapshots.repository_id = repositories.repository_id
                 )`,
            ).run();
        });

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
        const artifactCompatibilityHash = targetBuild.artifactCompatibilityHash;
        validateReuseCandidates(request.candidates);
        if (request.candidates.length === 0) return [];

        const reused: ReusedDocumentArtifacts[] = [];
        this.#transaction(() => {
            this.#database.exec(
                `CREATE TEMP TABLE IF NOT EXISTS reuse_document_candidates (
                    ordinal INTEGER PRIMARY KEY,
                    document_id TEXT NOT NULL UNIQUE,
                    file_revision_id TEXT NOT NULL,
                    compatible_encodings_json TEXT NOT NULL,
                    language TEXT NOT NULL,
                    format TEXT NOT NULL,
                    parser_id TEXT,
                    chunking_identity TEXT NOT NULL
                )`,
            );
            this.#database.exec("DELETE FROM reuse_document_candidates");
            const insertCandidate = this.#database.prepare(
                `INSERT INTO reuse_document_candidates(
                    ordinal, document_id, file_revision_id,
                    compatible_encodings_json, language, format,
                    parser_id, chunking_identity
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            );

            request.candidates.forEach((candidate, ordinal) => {
                insertCandidate.run(
                    ordinal,
                    candidate.documentId,
                    candidate.fileRevisionId,
                    JSON.stringify(candidate.compatibleEncodings),
                    candidate.language,
                    candidate.format,
                    candidate.parserId ?? null,
                    candidate.chunkingIdentity,
                );
            });

            const rows = this.#database.prepare(
                `SELECT rc.ordinal,
                        d.index_build_id AS source_index_build_id,
                        d.document_id,
                        b.model_json,
                        (
                            SELECT COUNT(*) FROM build_chunks counted
                            WHERE counted.index_build_id = d.index_build_id
                              AND counted.document_id = d.document_id
                        ) AS chunk_count
                 FROM reuse_document_candidates rc
                 JOIN documents d ON d.document_id = rc.document_id
                 JOIN builds b ON b.index_build_id = d.index_build_id
                 WHERE b.repository_id = ?
                   AND b.artifact_compatibility_hash = ?
                   AND b.status = 'ready'
                   AND json_extract(d.metadata_json, '$.fileRevisionId') =
                       rc.file_revision_id
                   AND json_extract(d.metadata_json, '$.language') = rc.language
                   AND json_extract(d.metadata_json, '$.format') = rc.format
                   AND json_extract(d.metadata_json, '$.parserId') IS rc.parser_id
                   AND EXISTS (
                       SELECT 1
                       FROM json_each(rc.compatible_encodings_json) encoding
                       WHERE encoding.value =
                           json_extract(d.metadata_json, '$.encoding')
                   )
                   AND EXISTS (
                       SELECT 1 FROM build_chunks present
                       WHERE present.index_build_id = d.index_build_id
                         AND present.document_id = d.document_id
                   )
                   AND NOT EXISTS (
                       SELECT 1
                       FROM build_chunks membership
                       JOIN chunks chunk
                         ON chunk.document_id = membership.document_id
                        AND chunk.chunk_id = membership.chunk_id
                       WHERE membership.index_build_id = d.index_build_id
                         AND membership.document_id = d.document_id
                         AND json_extract(
                             chunk.metadata_json,
                             '$.chunkingIdentity'
                         ) <> rc.chunking_identity
                   )
                 ORDER BY rc.ordinal,
                          COALESCE(b.completed_at, b.created_at) DESC,
                          b.created_at DESC,
                          b.index_build_id ASC`,
            ).all(
                targetBuild.repositoryId,
                artifactCompatibilityHash,
            ) as unknown as ReusableDocumentRow[];
            const selected = new Map<number, ReusableDocumentRow>();

            for (const row of rows) {
                if (
                    !selected.has(Number(row.ordinal)) &&
                    modelIdentityEquals(
                        JSON.parse(row.model_json) as EmbeddingModelIdentity,
                        targetBuild.modelIdentity,
                    )
                ) {
                    selected.set(Number(row.ordinal), row);
                }
            }

            const insertDocument = this.#database.prepare(
                `INSERT INTO documents(
                    index_build_id, document_id, metadata_json, content
                 )
                 SELECT ?, document_id, metadata_json, content
                 FROM documents
                 WHERE index_build_id = ? AND document_id = ?`,
            );
            const insertMemberships = this.#database.prepare(
                `INSERT INTO build_chunks(
                    index_build_id, document_id, chunk_id,
                    embedding_id, filter_json
                 )
                 SELECT ?, document_id, chunk_id, embedding_id, filter_json
                 FROM build_chunks
                 WHERE index_build_id = ? AND document_id = ?`,
            );

            for (let ordinal = 0; ordinal < request.candidates.length; ordinal += 1) {
                const row = selected.get(ordinal);
                if (row === undefined) continue;
                insertDocument.run(
                    request.targetIndexBuildId,
                    row.source_index_build_id,
                    row.document_id,
                );
                const result = insertMemberships.run(
                    request.targetIndexBuildId,
                    row.source_index_build_id,
                    row.document_id,
                );
                const chunkCount = Number(result.changes);
                if (chunkCount !== Number(row.chunk_count) || chunkCount < 1) {
                    throw new StorageError(
                        "storage-failure",
                        "Reusable document chunk membership copy is incomplete",
                        { documentId: row.document_id },
                    );
                }
                reused.push({
                    sourceIndexBuildId: row.source_index_build_id,
                    documentId: row.document_id,
                    chunkCount,
                });
            }
        });

        return reused;
    }

    async reuseChunkEmbeddings(
        indexBuildId: string,
        writes: readonly ChunkEmbeddingReferenceWrite[],
    ): Promise<readonly ReusedChunkEmbedding[]> {
        const statements = this.#requireWritableChunkStatements();
        const build = this.#requireBuilding(indexBuildId);
        const selectDocument = this.#database.prepare(
            `SELECT 1 FROM documents
             WHERE index_build_id = ? AND document_id = ?`,
        );
        const selectEmbedding = this.#database.prepare(
            `SELECT input_hash, model_json FROM embeddings
             WHERE embedding_id = ?`,
        );
        const storedDocuments = new Map<string, boolean>();
        const storedEmbeddings = new Map<
            string,
            { input_hash: string; model_json: string } | undefined
        >();
        const reusable: ChunkEmbeddingReferenceWrite[] = [];

        for (const write of writes) {
            validateChunkMetadata(write.chunk.metadata);
            validateFilterMetadata(write.filterMetadata);
            let documentIsStored = storedDocuments.get(write.documentId);

            if (documentIsStored === undefined) {
                documentIsStored =
                    selectDocument.get(indexBuildId, write.documentId) !== undefined;
                storedDocuments.set(write.documentId, documentIsStored);
            }

            if (
                write.chunk.metadata.documentId !== write.documentId ||
                !documentIsStored
            ) {
                throw new StorageError(
                    "invalid-record",
                    "Reusable chunk attribution does not match a stored document",
                    { documentId: write.documentId },
                );
            }

            let row = storedEmbeddings.get(write.embeddingId);

            if (!storedEmbeddings.has(write.embeddingId)) {
                row = selectEmbedding.get(write.embeddingId) as
                    | { input_hash: string; model_json: string }
                    | undefined;
                storedEmbeddings.set(write.embeddingId, row);
            }

            if (row === undefined) continue;
            if (
                row.input_hash !== write.inputHash ||
                !modelIdentityEquals(
                    JSON.parse(row.model_json) as EmbeddingModelIdentity,
                    build.modelIdentity,
                )
            ) {
                throw new StorageError(
                    "storage-failure",
                    "Content-addressed embedding identity is inconsistent",
                    { embeddingId: write.embeddingId },
                );
            }
            reusable.push(write);
        }

        this.#transaction(() => {
            for (const write of reusable) {
                statements.insertChunk.run(
                    write.documentId,
                    write.chunk.metadata.chunkId,
                    JSON.stringify(write.chunk.metadata),
                    write.chunk.content,
                );
                statements.insertBuildChunk.run(
                    indexBuildId,
                    write.documentId,
                    write.chunk.metadata.chunkId,
                    write.embeddingId,
                    JSON.stringify(write.filterMetadata),
                );
            }
        });

        return reusable.map((write) => ({
            documentId: write.documentId,
            chunkId: write.chunk.metadata.chunkId,
            embeddingId: write.embeddingId,
        }));
    }

    async vectorSearch(
        request: VectorSearchRequest,
    ): Promise<readonly VectorSearchResult[]> {
        const build = await this.getBuild(request.indexBuildId);

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
        const rows = this.#database.prepare(
            `SELECT bc.document_id, bc.chunk_id,
                    e.vector_json, e.model_json, bc.filter_json
             FROM build_chunks bc
             JOIN embeddings e ON e.embedding_id = bc.embedding_id
             WHERE bc.index_build_id = ?`,
        ).iterate(request.indexBuildId);
        const ranked: RankedMembership[] = [];

        for (const rawRow of rows) {
            const row = rawRow as SearchMembershipRow;
            const filterMetadata = JSON.parse(row.filter_json) as FilterMetadata;

            if (!matchesFilters(filterMetadata, request.filters)) {
                continue;
            }

            const model = JSON.parse(row.model_json) as EmbeddingModelIdentity;

            if (!modelIdentityEquals(model, request.modelIdentity)) {
                continue;
            }

            insertRankedMembership(ranked, {
                score: scoreVectors(
                    request.vector,
                    JSON.parse(row.vector_json) as number[],
                    request.modelIdentity.metric,
                ),
                documentId: row.document_id,
                chunkId: row.chunk_id,
                filterMetadata,
            }, request.limit);
        }

        const selectResult = this.#database.prepare(
            `SELECT d.metadata_json, d.content,
                    c.metadata_json AS chunk_metadata_json,
                    c.content AS chunk_content
             FROM documents d
             JOIN chunks c ON c.document_id = d.document_id
             WHERE d.index_build_id = ?
               AND d.document_id = ?
               AND c.chunk_id = ?`,
        );

        return ranked.map((candidate): VectorSearchResult => {
            const rawRow = selectResult.get(
                request.indexBuildId,
                candidate.documentId,
                candidate.chunkId,
            ) as
                | {
                    metadata_json: string;
                    content: string;
                    chunk_metadata_json: string;
                    chunk_content: string;
                }
                | undefined;

            if (rawRow === undefined) {
                throw new StorageError(
                    "storage-failure",
                    "Index build contains an incomplete search membership",
                    {
                        indexBuildId: request.indexBuildId,
                        documentId: candidate.documentId,
                        chunkId: candidate.chunkId,
                    },
                );
            }

            return {
                score: candidate.score,
                document: {
                    metadata: JSON.parse(rawRow.metadata_json) as
                        StoredDocument["metadata"],
                    content: rawRow.content,
                },
                chunk: {
                    metadata: JSON.parse(rawRow.chunk_metadata_json) as
                        StoredChunk["metadata"],
                    content: rawRow.chunk_content,
                },
                filterMetadata: candidate.filterMetadata,
            };
        });
    }

    async getChunkNeighborhood(
        request: ChunkNeighborhoodRequest,
    ): Promise<ChunkNeighborhood> {
        validateChunkNeighborhoodRequest(request);
        const build = await this.getBuild(request.indexBuildId);

        if (
            build === undefined ||
            build.status !== "ready" ||
            build.repositoryId !== request.repositoryId ||
            build.snapshotId !== request.snapshotId
        ) {
            return { before: [], after: [] };
        }

        const rows = this.#database.prepare(
            `SELECT c.metadata_json, c.content
             FROM build_chunks bc
             JOIN chunks c
               ON c.document_id = bc.document_id
              AND c.chunk_id = bc.chunk_id
             WHERE bc.index_build_id = ? AND bc.document_id = ?`,
        ).all(request.indexBuildId, request.documentId) as unknown as ChunkRow[];
        const chunks = rows.map((row) => ({
            metadata: JSON.parse(row.metadata_json) as StoredChunk["metadata"],
            content: row.content,
        })).sort(compareChunksBySourceOrder);
        const anchorIndex = chunks.findIndex(({ metadata }) =>
            metadata.chunkId === request.anchorChunkId
        );

        if (anchorIndex < 0) {
            return { before: [], after: [] };
        }

        return {
            before: chunks.slice(
                Math.max(0, anchorIndex - request.beforeChunks),
                anchorIndex,
            ),
            after: chunks.slice(
                anchorIndex + 1,
                anchorIndex + 1 + request.afterChunks,
            ),
        };
    }

    async getDocumentChunks(
        request: DocumentChunksRequest,
    ): Promise<DocumentChunks | undefined> {
        validateDocumentChunksRequest(request);
        const build = await this.getBuild(request.indexBuildId);

        if (build?.status !== "ready") {
            return undefined;
        }

        const documentRow = this.#database.prepare(
            `SELECT metadata_json, content
             FROM documents
             WHERE index_build_id = ?
               AND json_extract(metadata_json, '$.path') = ?
             LIMIT 1`,
        ).get(request.indexBuildId, request.path) as DocumentRow | undefined;

        if (documentRow === undefined) {
            return undefined;
        }

        const documentMetadata = JSON.parse(
            documentRow.metadata_json,
        ) as StoredDocument["metadata"];
        const chunkRows = this.#database.prepare(
            `SELECT c.metadata_json, c.content
             FROM build_chunks bc
             JOIN chunks c
               ON c.document_id = bc.document_id
              AND c.chunk_id = bc.chunk_id
             WHERE bc.index_build_id = ?
               AND bc.document_id = ?
             ORDER BY CAST(json_extract(c.metadata_json, '$.index') AS INTEGER),
                      c.chunk_id`,
        ).all(
            request.indexBuildId,
            documentMetadata.documentId,
        ) as unknown as ChunkRow[];

        return {
            document: {
                metadata: documentMetadata,
                content: documentRow.content,
            },
            chunks: chunkRows.map((row) => ({
                metadata: JSON.parse(row.metadata_json) as StoredChunk["metadata"],
                content: row.content,
            })),
        };
    }

    async close(): Promise<void> {
        this.#database.close();
    }

    #createSchema(): void {
        this.#database.exec(`
            CREATE TABLE IF NOT EXISTS repositories (
                repository_id TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS snapshots (
                snapshot_id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                source_identity TEXT NOT NULL,
                FOREIGN KEY(repository_id) REFERENCES repositories(repository_id)
            );
            CREATE TABLE IF NOT EXISTS builds (
                index_build_id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                snapshot_id TEXT NOT NULL,
                source_identity TEXT NOT NULL,
                source_provenance_json TEXT,
                configuration_hash TEXT NOT NULL,
                artifact_compatibility_hash TEXT,
                model_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY(repository_id) REFERENCES repositories(repository_id),
                FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id)
            );
            CREATE TABLE IF NOT EXISTS documents (
                index_build_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                content TEXT NOT NULL,
                PRIMARY KEY(index_build_id, document_id),
                FOREIGN KEY(index_build_id) REFERENCES builds(index_build_id)
            );
            CREATE TABLE IF NOT EXISTS chunks (
                document_id TEXT NOT NULL,
                chunk_id TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                content TEXT NOT NULL,
                PRIMARY KEY(document_id, chunk_id)
            );
            CREATE TABLE IF NOT EXISTS embeddings (
                embedding_id TEXT PRIMARY KEY,
                input_hash TEXT NOT NULL,
                model_json TEXT NOT NULL,
                vector_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS build_chunks (
                index_build_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                chunk_id TEXT NOT NULL,
                embedding_id TEXT NOT NULL,
                filter_json TEXT NOT NULL,
                PRIMARY KEY(index_build_id, document_id, chunk_id),
                FOREIGN KEY(index_build_id, document_id)
                    REFERENCES documents(index_build_id, document_id),
                FOREIGN KEY(document_id, chunk_id)
                    REFERENCES chunks(document_id, chunk_id),
                FOREIGN KEY(embedding_id) REFERENCES embeddings(embedding_id)
            );
            CREATE INDEX IF NOT EXISTS build_chunks_by_chunk
                ON build_chunks(document_id, chunk_id);
            CREATE INDEX IF NOT EXISTS build_chunks_by_embedding
                ON build_chunks(embedding_id);
            CREATE INDEX IF NOT EXISTS documents_by_document
                ON documents(document_id, index_build_id);
        `);
    }

    #migrateSchema(): void {
        const columns = this.#database.prepare(
            "PRAGMA table_info(builds)",
        ).all() as unknown as Array<{ name: string }>;

        if (!columns.some(({ name }) => name === "artifact_compatibility_hash")) {
            this.#database.exec(
                "ALTER TABLE builds ADD COLUMN artifact_compatibility_hash TEXT",
            );
        }
        if (!columns.some(({ name }) => name === "source_provenance_json")) {
            this.#database.exec(
                "ALTER TABLE builds ADD COLUMN source_provenance_json TEXT",
            );
        }
        this.#database.exec(
            `CREATE INDEX IF NOT EXISTS builds_by_artifact_compatibility
             ON builds(
                 repository_id, artifact_compatibility_hash, status,
                 completed_at, created_at
             )`,
        );
    }

    #requireBuilding(indexBuildId: string): IndexBuildRecord {
        const row = this.#database.prepare(
            "SELECT * FROM builds WHERE index_build_id = ?",
        ).get(indexBuildId);

        if (row === undefined) {
            throw new StorageError(
                "build-not-found",
                `Index build ${indexBuildId} does not exist`,
                { indexBuildId },
            );
        }

        if (row.status !== "building") {
            throw new StorageError(
                "invalid-record",
                `Index build ${indexBuildId} is not writable`,
                { indexBuildId, status: row.status },
            );
        }

        return buildFromRow(row);
    }

    #requireWritableChunkStatements(): WritableChunkStatements {
        if (
            this.#insertChunk === undefined ||
            this.#insertEmbedding === undefined ||
            this.#insertBuildChunk === undefined
        ) {
            throw new StorageError(
                "storage-failure",
                "SQLite storage was opened in read-only mode",
            );
        }

        return {
            insertChunk: this.#insertChunk,
            insertEmbedding: this.#insertEmbedding,
            insertBuildChunk: this.#insertBuildChunk,
        };
    }

    #transaction(operation: () => void): void {
        this.#database.exec("BEGIN IMMEDIATE");

        try {
            operation();
            this.#database.exec("COMMIT");
        } catch (error: unknown) {
            this.#database.exec("ROLLBACK");
            throw new StorageError(
                "storage-failure",
                "SQLite storage transaction failed",
                {},
                error,
            );
        }
    }
}

function immutableDatabaseUrl(path: string): URL {
    const url = pathToFileURL(path);
    url.searchParams.set("immutable", "1");
    return url;
}

function buildFromRow(row: Record<string, unknown>): IndexBuildRecord {
    return {
        indexBuildId: String(row.index_build_id),
        repositoryId: String(row.repository_id),
        snapshotId: String(row.snapshot_id),
        sourceIdentity: String(row.source_identity),
        ...(row.source_provenance_json === null ||
                row.source_provenance_json === undefined
            ? {}
            : {
                sourceProvenance: JSON.parse(
                    String(row.source_provenance_json),
                ) as NonNullable<IndexBuildRecord["sourceProvenance"]>,
            }),
        configurationHash: String(row.configuration_hash),
        ...(row.artifact_compatibility_hash === null ||
                row.artifact_compatibility_hash === undefined
            ? {}
            : {
                artifactCompatibilityHash:
                    String(row.artifact_compatibility_hash),
            }),
        modelIdentity: JSON.parse(String(row.model_json)) as EmbeddingModelIdentity,
        status: String(row.status) as IndexBuildRecord["status"],
        createdAt: String(row.created_at),
        ...(row.completed_at === null || row.completed_at === undefined
            ? {}
            : { completedAt: String(row.completed_at) }),
    };
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

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function insertRankedMembership(
    ranked: RankedMembership[],
    candidate: RankedMembership,
    limit: number,
): void {
    if (
        ranked.length === limit &&
        compareRankedMemberships(candidate, ranked[ranked.length - 1]!) >= 0
    ) {
        return;
    }

    let start = 0;
    let end = ranked.length;

    while (start < end) {
        const middle = Math.floor((start + end) / 2);

        if (compareRankedMemberships(candidate, ranked[middle]!) < 0) {
            end = middle;
        } else {
            start = middle + 1;
        }
    }

    ranked.splice(start, 0, candidate);

    if (ranked.length > limit) ranked.pop();
}

function compareRankedMemberships(
    left: RankedMembership,
    right: RankedMembership,
): number {
    return right.score - left.score ||
        compareText(left.chunkId, right.chunkId) ||
        compareText(left.documentId, right.documentId);
}

function compareChunksBySourceOrder(left: StoredChunk, right: StoredChunk): number {
    return left.metadata.index - right.metadata.index ||
        compareText(left.metadata.chunkId, right.metadata.chunkId);
}
