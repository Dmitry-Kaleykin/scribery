import {
    DocumentationCatalog,
    DocumentationService,
    documentationDatabasePath,
    type DocumentationManifest,
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
    DocumentationSearchInput,
    ScriberyMcpServerOptions,
} from "../contracts/server.js";

export class McpDocumentationService {
    readonly #catalog: DocumentationCatalog;
    readonly #options: ScriberyMcpServerOptions;

    constructor(options: ScriberyMcpServerOptions) {
        this.#options = options;
        this.#catalog = new DocumentationCatalog(options.documentationsDirectory);
    }

    async listDocumentations(): Promise<Readonly<Record<string, unknown>>> {
        const documentations = await this.#catalog.list();
        return { count: documentations.length, documentations };
    }

    async listSources(
        documentationReference: string,
    ): Promise<Readonly<Record<string, unknown>>> {
        const manifest = await this.#resolveManifest(documentationReference);
        return {
            documentationId: manifest.documentationId,
            name: manifest.name,
            sourceCount: manifest.sources.length,
            sourcesRevision: manifest.sourcesRevision,
            builtSourcesRevision: manifest.builtSourcesRevision,
            sources: manifest.sources,
        };
    }

    async search(
        input: DocumentationSearchInput,
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, unknown>>> {
        const manifest = await this.#resolveManifest(input.documentationReference);

        if (
            manifest.activeBuild === undefined ||
            manifest.builtSourcesRevision !== manifest.sourcesRevision
        ) {
            throw new Error(
                `Documentation ${manifest.name} must be built after its latest source changes`,
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
        const service = new DocumentationService({
            embeddingProvider,
            ...(rerankingProvider === undefined ? {} : { rerankingProvider }),
            ...(this.#options.documentationsDirectory === undefined
                ? {}
                : { documentationsDirectory: this.#options.documentationsDirectory }),
        });
        const results = await service.retrieve(manifest.documentationId, {
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
            documentationId: manifest.documentationId,
            name: manifest.name,
            indexBuildId: build.indexBuildId,
            resultCount: results.length,
            results,
        };
    }

    async #resolveManifest(
        requestedReference: string,
    ): Promise<DocumentationManifest> {
        return this.#catalog.resolve(requestedReference);
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
