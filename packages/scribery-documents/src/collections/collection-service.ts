import type { EmbeddingProvider } from "scribery-core";
import type { RerankingProvider } from "scribery-core";
import { SemanticRetriever, type RetrievalResult } from "scribery-core";
import { SqliteStorageProvider, type StorageFilterCondition } from "scribery-core";
import type {
    CollectionBuildOptions,
    CollectionBuildResult,
    CollectionDocumentInput,
    CollectionManifest,
    CollectionRetrievalRequest,
    CollectionSource,
    CollectionSummary,
    DeletedCollection,
    ResolvedCollectionBuild,
} from "./contracts/collection.js";
import { CollectionError } from "./errors/collection-error.js";
import { CollectionIndexer } from "./indexing/collection-indexer.js";
import { CollectionCatalog } from "./managed/catalog.js";
import { collectionDatabasePath } from "./managed/paths.js";

export interface CollectionServiceOptions {
    embeddingProvider: EmbeddingProvider;
    rerankingProvider?: RerankingProvider;
    collectionsDirectory?: string;
}

export class CollectionService {
    readonly #catalog: CollectionCatalog;
    readonly #embeddingProvider: EmbeddingProvider;
    readonly #rerankingProvider: RerankingProvider | undefined;

    constructor(options: CollectionServiceOptions) {
        this.#catalog = new CollectionCatalog(options.collectionsDirectory);
        this.#embeddingProvider = options.embeddingProvider;
        this.#rerankingProvider = options.rerankingProvider;
    }

    createCollection(name: string): Promise<CollectionManifest> {
        return this.#catalog.create(name);
    }

    listCollections(): Promise<readonly CollectionSummary[]> {
        return this.#catalog.list();
    }

    deleteCollection(reference: string): Promise<DeletedCollection> {
        return this.#catalog.delete(reference);
    }

    async listSources(reference: string): Promise<readonly CollectionSource[]> {
        return (await this.#catalog.resolve(reference)).sources;
    }

    upsertDocuments(
        reference: string,
        documents: readonly CollectionDocumentInput[],
    ): Promise<CollectionManifest> {
        return this.#catalog.upsertDocuments(reference, documents);
    }

    removeSources(
        reference: string,
        sourceIds: readonly string[],
    ): Promise<CollectionManifest> {
        return this.#catalog.removeSources(reference, sourceIds);
    }

    setSourceTags(
        reference: string,
        sourceIds: readonly string[],
        tags: readonly string[],
    ): Promise<CollectionManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "set", tags);
    }

    addSourceTags(
        reference: string,
        sourceIds: readonly string[],
        tags: readonly string[],
    ): Promise<CollectionManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "add", tags);
    }

    removeSourceTags(
        reference: string,
        sourceIds: readonly string[],
        tags: readonly string[],
    ): Promise<CollectionManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "remove", tags);
    }

    clearSourceTags(
        reference: string,
        sourceIds: readonly string[],
    ): Promise<CollectionManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "clear");
    }

    buildCollection(
        reference: string,
        options: CollectionBuildOptions = {},
    ): Promise<CollectionBuildResult> {
        return new CollectionIndexer(this.#catalog, this.#embeddingProvider)
            .build(reference, options);
    }

    async resolveActiveBuild(reference: string): Promise<ResolvedCollectionBuild> {
        const manifest = await this.#catalog.resolve(reference);

        if (
            manifest.activeBuild === undefined ||
            manifest.builtSourcesRevision !== manifest.sourcesRevision
        ) {
            throw new CollectionError(
                "build-required",
                `Collection ${manifest.name} must be built after its latest source changes`,
                {
                    collectionId: manifest.collectionId,
                    sourcesRevision: manifest.sourcesRevision,
                    builtSourcesRevision: manifest.builtSourcesRevision,
                },
            );
        }

        const databasePath = collectionDatabasePath(
            this.#catalog.baseDirectory,
            manifest.collectionId,
        );
        const storage = new SqliteStorageProvider(databasePath, {
            readOnly: true,
            immutable: true,
        });

        try {
            const build = await storage.getBuild(manifest.activeBuild.indexBuildId);

            if (build === undefined || build.status !== "ready") {
                throw new CollectionError(
                    "build-required",
                    `Active build for ${manifest.name} is not ready`,
                    { indexBuildId: manifest.activeBuild.indexBuildId },
                );
            }

            return { manifest, build, databasePath };
        } finally {
            await storage.close();
        }
    }

    async retrieve(
        reference: string,
        request: CollectionRetrievalRequest,
    ): Promise<readonly RetrievalResult[]> {
        const manifest = await this.#catalog.resolve(reference);
        const requestedSourceIds = request.scope?.sourceIds;

        if (requestedSourceIds !== undefined && requestedSourceIds.length === 0) {
            return [];
        }

        if (requestedSourceIds !== undefined) {
            const known = new Set(manifest.sources.map(({ sourceId }) => sourceId));
            const unknown = requestedSourceIds.filter((sourceId) => !known.has(sourceId));

            if (unknown.length > 0) {
                throw new CollectionError(
                    "source-not-found",
                    "Retrieval scope contains unknown collection sources",
                    { sourceIds: unknown },
                );
            }
        }

        const resolved = await this.resolveActiveBuild(reference);
        const storage = new SqliteStorageProvider(resolved.databasePath, {
            readOnly: true,
            immutable: true,
        });

        try {
            const filters: StorageFilterCondition[] = [];

            if (requestedSourceIds !== undefined) {
                filters.push({
                    field: "sourceId",
                    operator: "in",
                    value: [...new Set(requestedSourceIds)],
                });
            }

            if (request.scope?.tags !== undefined) {
                if (request.scope.tags.length === 0) return [];
                filters.push({
                    field: "tags",
                    operator: "in",
                    value: [...new Set(request.scope.tags)],
                });
            }

            return await new SemanticRetriever(
                storage,
                this.#embeddingProvider,
                this.#rerankingProvider,
            ).retrieve({
                repositoryId: resolved.build.repositoryId,
                snapshotId: resolved.build.snapshotId,
                indexBuildId: resolved.build.indexBuildId,
                query: request.query,
                ...(request.limit === undefined ? {} : { limit: request.limit }),
                ...(request.context === undefined ? {} : { context: request.context }),
                ...(request.rerank === undefined ? {} : { rerank: request.rerank }),
                ...(filters.length === 0 ? {} : { filters }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
        } finally {
            await storage.close();
        }
    }
}
