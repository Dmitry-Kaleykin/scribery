import {
    CollectionCatalog,
    CollectionService,
    collectionDatabasePath,
    type CollectionManifest,
} from "scribery-documents";
import {
    createOpenAiCompatibleRerankingProvider,
    openAiCompatibleEmbeddingProviderFromBuild,
} from "scribery-core";
import {
    SqliteStorageProvider,
    type IndexBuildRecord,
} from "scribery-core";
import { MCP_DEFAULT_RESULT_LIMIT } from "../constants/defaults.js";
import type {
    CollectionSearchInput,
    ScriberyMcpServerOptions,
} from "../contracts/server.js";

export class McpCollectionService {
    readonly #catalog: CollectionCatalog;
    readonly #options: ScriberyMcpServerOptions;

    constructor(options: ScriberyMcpServerOptions) {
        this.#options = options;
        this.#catalog = new CollectionCatalog(options.collectionsDirectory);
    }

    async listCollections(): Promise<Readonly<Record<string, unknown>>> {
        const collections = await this.#catalog.list();
        return { count: collections.length, collections };
    }

    async listSources(
        collectionReference?: string,
    ): Promise<Readonly<Record<string, unknown>>> {
        const manifest = await this.#resolveManifest(collectionReference);
        return {
            collectionId: manifest.collectionId,
            name: manifest.name,
            sourceCount: manifest.sources.length,
            sourcesRevision: manifest.sourcesRevision,
            builtSourcesRevision: manifest.builtSourcesRevision,
            sources: manifest.sources,
        };
    }

    async search(
        input: CollectionSearchInput,
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, unknown>>> {
        const manifest = await this.#resolveManifest(input.collectionReference);

        if (
            manifest.activeBuild === undefined ||
            manifest.builtSourcesRevision !== manifest.sourcesRevision
        ) {
            throw new Error(
                `Collection ${manifest.name} must be built after its latest source changes`,
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
        let build: IndexBuildRecord | undefined;

        try {
            build = await storage.getBuild(manifest.activeBuild.indexBuildId);
        } finally {
            await storage.close();
        }

        if (build === undefined || build.status !== "ready") {
            throw new Error(`Active build for ${manifest.name} is not ready`);
        }

        const providerOptions = this.#providerOptions();
        const embeddingProvider = openAiCompatibleEmbeddingProviderFromBuild(
            build,
            providerOptions,
        );
        if (input.rerank === false && input.rerankCandidates !== undefined) {
            throw new Error(
                "rerankCandidates cannot be used when rerank is false",
            );
        }
        const rerankingRequested = input.rerank ?? (
            input.rerankCandidates !== undefined ||
            this.#options.rerankingModel !== undefined
        );
        const rerankingProvider = rerankingRequested
            ? this.#createRerankingProvider()
            : undefined;
        const service = new CollectionService({
            embeddingProvider,
            ...(rerankingProvider === undefined ? {} : { rerankingProvider }),
            ...(this.#options.collectionsDirectory === undefined
                ? {}
                : { collectionsDirectory: this.#options.collectionsDirectory }),
        });
        const results = await service.retrieve(manifest.collectionId, {
            query: input.query,
            limit: input.limit ?? MCP_DEFAULT_RESULT_LIMIT,
            ...(input.sourceIds === undefined && input.tags === undefined
                ? {}
                : {
                    scope: {
                        ...(input.sourceIds === undefined
                            ? {}
                            : { sourceIds: input.sourceIds }),
                        ...(input.tags === undefined ? {} : { tags: input.tags }),
                    },
                }),
            ...(input.includeContext === false
                ? {}
                : {
                    context: {
                        ...(input.contextBefore === undefined
                            ? {}
                            : { beforeChunks: input.contextBefore }),
                        ...(input.contextAfter === undefined
                            ? {}
                            : { afterChunks: input.contextAfter }),
                        ...(input.contextCharacters === undefined
                            ? {}
                            : { maximumCharacters: input.contextCharacters }),
                    },
                }),
            ...(rerankingProvider === undefined
                ? {}
                : {
                    rerank: {
                        ...(input.rerankCandidates === undefined
                            ? {}
                            : { candidateLimit: input.rerankCandidates }),
                    },
                }),
            ...(signal === undefined ? {} : { signal }),
        });

        return {
            collectionId: manifest.collectionId,
            name: manifest.name,
            indexBuildId: build.indexBuildId,
            resultCount: results.length,
            results,
        };
    }

    async #resolveManifest(
        requestedReference: string | undefined,
    ): Promise<CollectionManifest> {
        const reference = requestedReference ??
            this.#options.defaultCollectionReference;

        if (reference !== undefined) {
            return this.#catalog.resolve(reference);
        }

        const collections = await this.#catalog.list();
        if (collections.length === 1) {
            return this.#catalog.resolve(collections[0]!.collectionId);
        }
        if (collections.length === 0) {
            throw new Error("No managed collections are available");
        }

        throw new Error(
            "Multiple collections are available; configure --collection or provide collection",
        );
    }

    #providerOptions(): { baseUrl?: string; apiKey?: string } {
        return {
            ...(this.#options.baseUrl === undefined
                ? {}
                : { baseUrl: this.#options.baseUrl }),
            ...(this.#options.apiKey === undefined
                ? {}
                : { apiKey: this.#options.apiKey }),
        };
    }

    #createRerankingProvider() {
        if (this.#options.rerankingModel === undefined) {
            throw new Error(
                "Reranking was requested, but the MCP server has no --rerank-model",
            );
        }

        return createOpenAiCompatibleRerankingProvider({
            model: this.#options.rerankingModel,
            ...(this.#options.rerankingProtocol === undefined
                ? {}
                : { protocol: this.#options.rerankingProtocol }),
            ...this.#providerOptions(),
            ...(this.#options.rerankingInstruction === undefined
                ? {}
                : { instruction: this.#options.rerankingInstruction }),
        });
    }
}
