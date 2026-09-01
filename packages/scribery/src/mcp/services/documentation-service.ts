import {
    DocumentationCatalog,
    DocumentationService,
    documentationDatabasePath,
    type DocumentationManifest,
} from "scribery-documents";
import {
    createOpenAiCompatibleRerankingProvider,
    normalizeRelativePath,
    openAiCompatibleEmbeddingProviderFromBuild,
} from "scribery-core";
import {
    SqliteStorageProvider,
    type IndexBuildRecord,
} from "scribery-core";
import {
    MCP_DEFAULT_DOCUMENTATION_SOURCE_CHARACTERS,
    MCP_DEFAULT_RESULT_LIMIT,
} from "../constants/defaults.js";
import type {
    DocumentationSearchInput,
    DocumentationSourceReadInput,
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
        return {
            documentations: documentations.map(({ name, description }) => ({
                name,
                description: description ?? "",
            })),
        };
    }

    async readSource(
        input: DocumentationSourceReadInput,
    ): Promise<Readonly<Record<string, unknown>>> {
        const { manifest, build, databasePath } = await this.#resolveActiveBuild(
            input.documentationReference,
        );
        const requestedSource = input.sourceReference.trim();
        const indexedSources = manifest.activeBuild!.indexedSources;
        let source = indexedSources.find(({ sourceId }) =>
            sourceId === requestedSource
        );

        if (source === undefined) {
            const logicalPath = normalizeRelativePath(requestedSource);
            source = indexedSources.find(({ logicalPath: candidate }) =>
                candidate === logicalPath
            );
        }

        if (source === undefined) {
            throw new Error(
                `Documentation source ${requestedSource} was not found in ${manifest.name}`,
            );
        }

        const storage = new SqliteStorageProvider(databasePath, {
            readOnly: true,
            immutable: true,
        });

        try {
            const result = await storage.getDocumentChunks({
                indexBuildId: build.indexBuildId,
                path: source.logicalPath,
            });

            if (result === undefined) {
                throw new Error(
                    `Documentation source ${source.logicalPath} has no readable content ` +
                    `in build ${build.indexBuildId}`,
                );
            }

            const content = result.document.content;
            const start = input.start ?? 0;

            if (start > content.length) {
                throw new Error(
                    `Source start ${start} exceeds its ${content.length}-character length`,
                );
            }

            const maximumCharacters = input.maximumCharacters ??
                MCP_DEFAULT_DOCUMENTATION_SOURCE_CHARACTERS;
            const end = Math.min(content.length, start + maximumCharacters);

            return {
                documentationId: manifest.documentationId,
                name: manifest.name,
                indexBuildId: build.indexBuildId,
                sourceId: source.sourceId,
                sourceDefinitionId: source.sourceDefinitionId,
                path: source.logicalPath,
                title: source.title,
                ...(source.mediaType === undefined
                    ? {}
                    : { mediaType: source.mediaType }),
                tags: source.tags,
                attributes: source.attributes,
                start,
                end,
                totalCharacters: content.length,
                hasMore: end < content.length,
                ...(end < content.length ? { nextStart: end } : {}),
                content: content.slice(start, end),
            };
        } finally {
            await storage.close();
        }
    }

    async search(
        input: DocumentationSearchInput,
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, unknown>>> {
        const { manifest, build } = await this.#resolveActiveBuild(
            input.documentationReference,
        );

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

    async #resolveActiveBuild(
        requestedReference: string,
    ): Promise<{
        manifest: DocumentationManifest;
        build: IndexBuildRecord;
        databasePath: string;
    }> {
        const manifest = await this.#resolveManifest(requestedReference);

        if (
            manifest.activeBuild === undefined ||
            manifest.activeBuild.configurationRevision !== manifest.configurationRevision
        ) {
            throw new Error(
                `Documentation ${manifest.name} must be indexed after its latest source changes`,
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
                throw new Error(`Active build for ${manifest.name} is not ready`);
            }

            return { manifest, build, databasePath };
        } finally {
            await storage.close();
        }
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
