import { ProviderProfileService } from "scribery-core";
import {
    openAiCompatibleEmbeddingProviderFromBuild,
    SemanticRetriever,
} from "scribery-core";
import { SqliteStorageProvider } from "scribery-core";
import type {
    ProjectSearchRequest,
    ProjectSearchResult,
} from "../contracts/project-search.js";
import { managedIndexesDirectory } from "../managed/paths.js";
import { ProjectRetrievalTargetService } from "./retrieval-target-service.js";

export interface ProjectSearchServiceOptions {
    indexesDirectory?: string;
    profilesPath?: string;
    apiKey?: string | undefined;
    fetch?: typeof globalThis.fetch;
}

export class ProjectSearchService {
    readonly #profiles: ProviderProfileService;
    readonly #targets: ProjectRetrievalTargetService;
    readonly #apiKey: string | undefined;
    readonly #fetch: typeof globalThis.fetch | undefined;

    constructor(options: ProjectSearchServiceOptions = {}) {
        this.#profiles = new ProviderProfileService({
            ...(options.profilesPath === undefined
                ? {}
                : { profilesPath: options.profilesPath }),
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        this.#targets = new ProjectRetrievalTargetService({
            indexesDirectory: options.indexesDirectory ??
                managedIndexesDirectory(),
        });
        this.#apiKey = options.apiKey;
        this.#fetch = options.fetch;
    }

    async search(
        request: ProjectSearchRequest,
        currentDirectory = process.cwd(),
    ): Promise<ProjectSearchResult> {
        const project = await this.#targets.resolveProject(
            request.projectReference,
            currentDirectory,
        );
        const selection = request.indexBuildId === undefined
            ? await this.#targets.activeSelection(project)
            : {
                type: "requested-build" as const,
                indexBuildId: request.indexBuildId,
            };
        if (selection === undefined) {
            throw new Error(
                `Indexed project ${project.projectIdentifier} has no ready build`,
            );
        }
        const profile = request.profile === undefined
            ? undefined
            : await this.#profiles.get(request.profile);
        const storage = new SqliteStorageProvider(project.databasePath, {
            readOnly: true,
            immutable: true,
        });

        try {
            const build = await storage.getBuild(selection.indexBuildId);
            if (build === undefined) {
                throw new Error(
                    `Index build ${selection.indexBuildId} was not found`,
                );
            }
            if (build.status !== "ready") {
                throw new Error(
                    `Index build ${selection.indexBuildId} is ${build.status}; only ready builds can be searched`,
                );
            }
            const embeddings = openAiCompatibleEmbeddingProviderFromBuild(build, {
                ...(profile?.embedding.baseUrl === undefined
                    ? {}
                    : { baseUrl: profile.embedding.baseUrl }),
                ...(this.#apiKey === undefined
                    ? {}
                    : { apiKey: this.#apiKey }),
                ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
            });
            const rerankingEnabled = request.reranking?.enabled ??
                profile?.reranking !== undefined;
            const reranking = rerankingEnabled && profile !== undefined
                ? this.#profiles.createRerankingProvider(profile)
                : undefined;
            if (rerankingEnabled && reranking === undefined) {
                throw new Error(
                    "Project search requested reranking without a configured reranking profile",
                );
            }
            const results = await new SemanticRetriever(
                storage,
                embeddings,
                reranking,
            ).retrieve({
                repositoryId: build.repositoryId,
                snapshotId: build.snapshotId,
                indexBuildId: build.indexBuildId,
                query: request.query,
                ...(request.limit === undefined
                    ? {}
                    : { limit: request.limit }),
                ...(request.language === undefined
                    ? {}
                    : {
                        filters: [{
                            field: "language" as const,
                            operator: "equals" as const,
                            value: request.language,
                        }],
                    }),
                ...(request.context === undefined
                    ? {}
                    : { context: request.context }),
                ...(reranking === undefined
                    ? {}
                    : {
                        rerank: {
                            ...(request.reranking?.candidateLimit === undefined
                                ? {}
                                : {
                                    candidateLimit:
                                        request.reranking.candidateLimit,
                                }),
                            ...(request.reranking?.failureMode === undefined
                                ? {}
                                : {
                                    failureMode:
                                        request.reranking.failureMode,
                                }),
                        },
                    }),
                ...(request.signal === undefined
                    ? {}
                    : { signal: request.signal }),
            });
            return {
                projectIdentifier: project.projectIdentifier,
                ...(project.root === undefined ? {} : { root: project.root }),
                databasePath: project.databasePath,
                indexBuildId: build.indexBuildId,
                retrievalSelection: selection,
                resultCount: results.length,
                results,
            };
        } finally {
            await storage.close();
        }
    }
}
