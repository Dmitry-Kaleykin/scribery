import { normalizeRelativePath } from "scribery-core";
import {
    listIndexedProjects,
    ProjectRetrievalTargetService,
    type ResolvedProjectRetrievalSelection,
    type IndexedProjectSummary,
    type ProjectSearchResult,
} from "scribery-code";
import {
    createOpenAiCompatibleRerankingProvider,
    openAiCompatibleEmbeddingProviderFromBuild,
    SemanticRetriever,
} from "scribery-core";
import { SqliteStorageProvider, type IndexBuildRecord } from "scribery-core";
import {
    MCP_DEFAULT_CHUNK_PAGE_SIZE,
    MCP_DEFAULT_RESULT_LIMIT,
} from "../constants/defaults.js";
import type {
    ProjectChunksInput,
    ProjectSearchInput,
    ScriberyMcpServerOptions,
} from "../contracts/server.js";

interface ResolvedProjectBuild {
    project: IndexedProjectSummary;
    build: IndexBuildRecord;
    storage: SqliteStorageProvider;
    selection: ResolvedProjectRetrievalSelection | {
        type: "requested-build";
        indexBuildId: string;
    };
}

export class McpProjectService {
    readonly #options: ScriberyMcpServerOptions;
    readonly #targets: ProjectRetrievalTargetService;

    constructor(options: ScriberyMcpServerOptions) {
        this.#options = options;
        this.#targets = new ProjectRetrievalTargetService({
            ...(options.indexesDirectory === undefined
                ? {}
                : { indexesDirectory: options.indexesDirectory }),
        });
    }

    async listProjects(): Promise<Readonly<Record<string, unknown>>> {
        const projects = await listIndexedProjects(this.#options.indexesDirectory);
        const withSelections = await Promise.all(projects.map(async (project) => ({
            ...project,
            retrievalSelection: await this.#targets.activeSelection(project),
        })));
        return { count: withSelections.length, projects: withSelections };
    }

    async search(
        input: ProjectSearchInput,
        signal?: AbortSignal,
    ): Promise<ProjectSearchResult> {
        const resolved = await this.#openBuild(
            input.projectReference,
            input.indexBuildId,
        );

        try {
            const embeddingProvider = openAiCompatibleEmbeddingProviderFromBuild(
                resolved.build,
                this.#providerOptions(),
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
            const retriever = new SemanticRetriever(
                resolved.storage,
                embeddingProvider,
                rerankingProvider,
            );
            const results = await retriever.retrieve({
                repositoryId: resolved.build.repositoryId,
                snapshotId: resolved.build.snapshotId,
                indexBuildId: resolved.build.indexBuildId,
                query: input.query,
                limit: input.limit ?? MCP_DEFAULT_RESULT_LIMIT,
                ...(input.language === undefined
                    ? {}
                    : {
                        filters: [{
                            field: "language" as const,
                            operator: "equals" as const,
                            value: input.language,
                        }],
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
                projectIdentifier: resolved.project.projectIdentifier,
                ...(resolved.project.root === undefined
                    ? {}
                    : { root: resolved.project.root }),
                databasePath: resolved.project.databasePath,
                indexBuildId: resolved.build.indexBuildId,
                retrievalSelection: resolved.selection,
                resultCount: results.length,
                results,
            };
        } finally {
            await resolved.storage.close();
        }
    }

    async chunks(
        input: ProjectChunksInput,
    ): Promise<Readonly<Record<string, unknown>>> {
        const resolved = await this.#openBuild(
            input.projectReference,
            input.indexBuildId,
        );

        try {
            const path = normalizeRelativePath(input.path);
            const result = await resolved.storage.getDocumentChunks({
                indexBuildId: resolved.build.indexBuildId,
                path,
            });

            if (result === undefined) {
                throw new Error(
                    `Indexed file ${path} was not found in build ${resolved.build.indexBuildId}`,
                );
            }

            const start = input.start ?? 0;
            const limit = input.limit ?? MCP_DEFAULT_CHUNK_PAGE_SIZE;
            const chunks = result.chunks.slice(start, start + limit);

            return {
                projectIdentifier: resolved.project.projectIdentifier,
                indexBuildId: resolved.build.indexBuildId,
                retrievalSelection: resolved.selection,
                path,
                document: { metadata: result.document.metadata },
                chunkCount: result.chunks.length,
                start,
                returnedChunks: chunks.length,
                hasMore: start + chunks.length < result.chunks.length,
                chunks,
            };
        } finally {
            await resolved.storage.close();
        }
    }

    async #openBuild(
        requestedProject: string | undefined,
        requestedBuild: string | undefined,
    ): Promise<ResolvedProjectBuild> {
        const project = await this.#targets.resolveProject(
            requestedProject ?? this.#options.defaultProjectReference,
        );
        const selection = requestedBuild === undefined
            ? await this.#targets.activeSelection(project)
            : {
                type: "requested-build" as const,
                indexBuildId: requestedBuild,
            };
        const indexBuildId = selection?.indexBuildId;

        if (indexBuildId === undefined) {
            throw new Error(
                `Indexed project ${project.projectIdentifier} has no ready build`,
            );
        }

        const storage = new SqliteStorageProvider(project.databasePath, {
            readOnly: true,
            immutable: true,
        });

        try {
            const build = await storage.getBuild(indexBuildId);

            if (build === undefined) {
                throw new Error(`Index build ${indexBuildId} was not found`);
            }
            if (build.status !== "ready") {
                throw new Error(
                    `Index build ${indexBuildId} is ${build.status}; only ready builds can be read`,
                );
            }

            return { project, build, storage, selection: selection! };
        } catch (error: unknown) {
            await storage.close();
            throw error;
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
