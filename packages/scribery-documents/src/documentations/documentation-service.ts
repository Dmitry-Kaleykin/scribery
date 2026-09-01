import type { EmbeddingProvider } from "scribery-core";
import type { RerankingProvider } from "scribery-core";
import { SemanticRetriever, type RetrievalResult } from "scribery-core";
import { SqliteStorageProvider, type StorageFilterCondition } from "scribery-core";
import type {
    DocumentationDirectoryInput,
    DocumentationIndexOptions,
    DocumentationIndexResult,
    DocumentationInput,
    DocumentationManifest,
    DocumentationRetrievalRequest,
    DocumentationSourceDefinition,
    DocumentationSummary,
    DeletedDocumentation,
    IndexedDocumentationSource,
    ResolvedDocumentationBuild,
} from "./contracts/documentation.js";
import { DocumentationError } from "./errors/documentation-error.js";
import { DocumentationIndexer } from "./indexing/documentation-indexer.js";
import { DocumentationCatalog } from "./managed/catalog.js";
import { documentationDatabasePath } from "./managed/paths.js";

export interface DocumentationServiceOptions {
    embeddingProvider: EmbeddingProvider;
    rerankingProvider?: RerankingProvider;
    documentationsDirectory?: string;
}

export class DocumentationService {
    readonly #catalog: DocumentationCatalog;
    readonly #embeddingProvider: EmbeddingProvider;
    readonly #rerankingProvider: RerankingProvider | undefined;

    constructor(options: DocumentationServiceOptions) {
        this.#catalog = new DocumentationCatalog(options.documentationsDirectory);
        this.#embeddingProvider = options.embeddingProvider;
        this.#rerankingProvider = options.rerankingProvider;
    }

    createDocumentation(
        name: string,
        description?: string,
    ): Promise<DocumentationManifest> {
        return this.#catalog.create(name, description);
    }

    listDocumentations(): Promise<readonly DocumentationSummary[]> {
        return this.#catalog.list();
    }

    setDocumentationDescription(
        reference: string,
        description?: string,
    ): Promise<DocumentationManifest> {
        return this.#catalog.setDescription(reference, description);
    }

    deleteDocumentation(reference: string): Promise<DeletedDocumentation> {
        return this.#catalog.delete(reference);
    }

    async listSourceDefinitions(
        reference: string,
    ): Promise<readonly DocumentationSourceDefinition[]> {
        return (await this.#catalog.resolve(reference)).sourceDefinitions;
    }

    async listIndexedSources(
        reference: string,
    ): Promise<readonly IndexedDocumentationSource[]> {
        return (await this.resolveActiveBuild(reference)).manifest.activeBuild!.indexedSources;
    }

    addDirectorySource(
        reference: string,
        input: DocumentationDirectoryInput,
    ): Promise<DocumentationManifest> {
        return this.#catalog.addDirectorySource(reference, input);
    }

    upsertDocuments(
        reference: string,
        documents: readonly DocumentationInput[],
    ): Promise<DocumentationManifest> {
        return this.#catalog.upsertDocuments(reference, documents);
    }

    removeSourceDefinitions(
        reference: string,
        sourceIds: readonly string[],
    ): Promise<DocumentationManifest> {
        return this.#catalog.removeSourceDefinitions(reference, sourceIds);
    }

    setSourceTags(
        reference: string,
        sourceIds: readonly string[],
        tags: readonly string[],
    ): Promise<DocumentationManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "set", tags);
    }

    addSourceTags(
        reference: string,
        sourceIds: readonly string[],
        tags: readonly string[],
    ): Promise<DocumentationManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "add", tags);
    }

    removeSourceTags(
        reference: string,
        sourceIds: readonly string[],
        tags: readonly string[],
    ): Promise<DocumentationManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "remove", tags);
    }

    clearSourceTags(
        reference: string,
        sourceIds: readonly string[],
    ): Promise<DocumentationManifest> {
        return this.#catalog.updateSourceTags(reference, sourceIds, "clear");
    }

    indexDocumentation(
        reference: string,
        options: DocumentationIndexOptions = {},
    ): Promise<DocumentationIndexResult> {
        return new DocumentationIndexer(this.#catalog, this.#embeddingProvider)
            .index(reference, options);
    }

    async resolveActiveBuild(reference: string): Promise<ResolvedDocumentationBuild> {
        const manifest = await this.#catalog.resolve(reference);

        if (
            manifest.activeBuild === undefined ||
            manifest.activeBuild.configurationRevision !== manifest.configurationRevision
        ) {
            throw new DocumentationError(
                "index-required",
                `Documentation ${manifest.name} must be indexed after its latest source changes`,
                {
                    documentationId: manifest.documentationId,
                    configurationRevision: manifest.configurationRevision,
                    indexedConfigurationRevision:
                        manifest.activeBuild?.configurationRevision,
                },
            );
        }

        const databasePath = documentationDatabasePath(
            this.#catalog.baseDirectory,
            manifest.documentationId,
        );
        const storage = new SqliteStorageProvider(databasePath, {
            readOnly: true,
            immutable: true,
        });

        try {
            const build = await storage.getBuild(manifest.activeBuild.indexBuildId);

            if (build === undefined || build.status !== "ready") {
                throw new DocumentationError(
                    "index-required",
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
        request: DocumentationRetrievalRequest,
    ): Promise<readonly RetrievalResult[]> {
        const requestedSourceIds = request.scope?.sourceIds;

        if (requestedSourceIds !== undefined && requestedSourceIds.length === 0) {
            return [];
        }

        if (requestedSourceIds !== undefined) {
            const resolved = await this.resolveActiveBuild(reference);
            const known = new Set(
                resolved.manifest.activeBuild!.indexedSources.map(({ sourceId }) => sourceId),
            );
            const unknown = requestedSourceIds.filter((sourceId) => !known.has(sourceId));

            if (unknown.length > 0) {
                throw new DocumentationError(
                    "source-not-found",
                    "Retrieval scope contains unknown documentation sources",
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
