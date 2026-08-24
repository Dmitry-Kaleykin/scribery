import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
    diagnoseEmbeddingProvider,
    type EmbeddingProvider,
} from "scribery-core";
import { IndexingCoordinator } from "../../indexing/index.js";
import { SqliteStorageProvider } from "scribery-core";
import {
    ProviderProfileService,
} from "scribery-core";
import type {
    ProjectIndexingEvent,
    ProjectIndexingOutcome,
    ProjectIndexingRequest,
} from "../contracts/project-indexing.js";
import type {
    ProjectIndexingProvider,
    ProjectIndexingRecipe,
    ProjectIndexingSettings,
} from "../contracts/indexing-recipe.js";
import { PROJECT_INDEXING_EVENT_VERSION } from "../constants/indexing.js";
import { ProjectIndexingRecipeCatalog } from "../managed/indexing-recipe.js";
import {
    managedDatabasePath,
    managedIndexesDirectory,
} from "../managed/paths.js";
import { writeManagedProjectManifest } from "../managed/manifest.js";
import { ProjectRetrievalTargetService } from "../retrieval/retrieval-target-service.js";
import { normalizeRetrievalTargetName } from "../retrieval/target-catalog.js";
import { writeIndexingLog } from "./write-indexing-log.js";

export interface ProjectIndexingServiceOptions {
    indexesDirectory?: string;
    profilesPath?: string;
    apiKey?: string | undefined;
    fetch?: typeof globalThis.fetch;
}

export class ProjectIndexingService {
    readonly #indexesDirectory: string;
    readonly #profiles: ProviderProfileService;
    readonly #recipes: ProjectIndexingRecipeCatalog;
    readonly #retrieval: ProjectRetrievalTargetService;

    constructor(options: ProjectIndexingServiceOptions = {}) {
        this.#indexesDirectory = options.indexesDirectory ??
            managedIndexesDirectory();
        this.#profiles = new ProviderProfileService({
            ...(options.profilesPath === undefined
                ? {}
                : { profilesPath: options.profilesPath }),
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        this.#recipes = new ProjectIndexingRecipeCatalog(this.#indexesDirectory);
        this.#retrieval = new ProjectRetrievalTargetService({
            indexesDirectory: this.#indexesDirectory,
        });
    }

    async index(request: ProjectIndexingRequest): Promise<ProjectIndexingOutcome> {
        if (
            !Number.isSafeInteger(request.keepReplacedBuilds) ||
            request.keepReplacedBuilds < 0
        ) {
            throw new Error(
                "Replaced build retention must be a non-negative integer",
            );
        }
        const target = request.target === undefined
            ? undefined
            : normalizeRetrievalTargetName(request.target);
        const root = resolve(request.root);
        const databasePath = resolve(
            request.databasePath ??
                managedDatabasePath(root, this.#indexesDirectory),
        );
        const provider = await this.#embeddingProvider(request.provider);
        if (request.diagnoseProvider !== false) {
            emit(request, {
                type: "provider-diagnostic",
                state: "started",
                model: provider.identity.model,
                dimensions: provider.identity.dimensions,
            });
            const diagnostic = await diagnoseEmbeddingProvider(provider, {
                ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
            emit(request, {
                type: "provider-diagnostic",
                state: "completed",
                result: diagnostic,
            });
        }

        await mkdir(dirname(databasePath), { recursive: true });
        const project = await writeManagedProjectManifest(
            root,
            databasePath,
            this.#indexesDirectory,
        );
        if (target !== undefined && project === undefined) {
            throw new Error(
                "A retrieval target is available only for a managed project index",
            );
        }

        const storage = new SqliteStorageProvider(databasePath);
        const result = await (async () => {
            try {
                return await new IndexingCoordinator(storage, provider).index({
                    root,
                    onProgress: (progress) => emit(request, {
                        type: "indexing-progress",
                        progress,
                    }),
                    ...(request.signal === undefined
                        ? {}
                        : { signal: request.signal }),
                    ...(request.allowDirty === undefined
                        ? {}
                        : { allowDirty: request.allowDirty }),
                    ...(request.maximumChunkSize === undefined
                        ? {}
                        : { maximumChunkSize: request.maximumChunkSize }),
                    ...(request.windows1251 === true
                        ? { encodingFallback: "windows-1251" as const }
                        : {}),
                    ...(request.include === undefined
                        ? {}
                        : { include: request.include }),
                    ...(request.exclude === undefined
                        ? {}
                        : { exclude: request.exclude }),
                    maximumEmbeddingInputsPerBatch: provider.maximumInputs,
                });
            } finally {
                await storage.close();
            }
        })();
        const summary = await writeIndexingLog(root, databasePath, result);

        let retrieval: Readonly<Record<string, unknown>> | undefined;
        if (target !== undefined && project !== undefined) {
            emit(request, {
                type: "target-publication",
                state: "started",
                target,
                indexBuildId: result.indexBuildId,
            });
            retrieval = await this.#retrieval.assignTarget(
                project.projectIdentifier,
                target,
                result.indexBuildId,
                true,
                request.keepReplacedBuilds,
            );
            emit(request, {
                type: "target-publication",
                state: "completed",
                target,
                indexBuildId: result.indexBuildId,
            });
        }

        const recipe = project === undefined || request.persistRecipe === false
            ? undefined
            : await this.#recipes.write(
                project.projectIdentifier,
                settingsFromRequest(request, target),
            );
        if (recipe !== undefined) {
            emit(request, {
                type: "recipe-save",
                state: "completed",
                projectIdentifier: recipe.projectIdentifier,
            });
        }
        emit(request, {
            type: "operation-complete",
            ...(project === undefined
                ? {}
                : { projectIdentifier: project.projectIdentifier }),
            indexBuildId: result.indexBuildId,
        });

        return {
            root,
            databasePath,
            ...(project === undefined ? {} : { project }),
            result,
            summary,
            ...(retrieval === undefined ? {} : { retrieval }),
            ...(recipe === undefined ? {} : { recipe }),
        };
    }

    async reindex(
        reference?: string,
        currentDirectory = process.cwd(),
        onEvent?: (event: ProjectIndexingEvent) => void,
        signal?: AbortSignal,
    ): Promise<ProjectIndexingOutcome> {
        const project = await this.#retrieval.resolveProject(
            reference,
            currentDirectory,
        );
        const recipe = await this.#recipes.read(project.projectIdentifier);
        if (recipe === undefined) {
            throw new Error(
                `Indexed project ${project.projectIdentifier} has no saved indexing recipe`,
            );
        }
        if (project.root === undefined) {
            throw new Error(
                `Indexed project ${project.projectIdentifier} has no recorded source root`,
            );
        }
        return this.index({
            root: project.root,
            databasePath: project.databasePath,
            ...settingsFromRecipe(recipe),
            ...(onEvent === undefined ? {} : { onEvent }),
            ...(signal === undefined ? {} : { signal }),
        });
    }

    async recipe(
        reference?: string,
        currentDirectory = process.cwd(),
    ): Promise<ProjectIndexingRecipe | undefined> {
        const project = await this.#retrieval.resolveProject(
            reference,
            currentDirectory,
        );
        return this.#recipes.read(project.projectIdentifier);
    }

    async replaceProviderProfileReferences(
        currentName: string,
        nextName: string,
    ): Promise<number> {
        return this.#recipes.replaceProviderProfileReferences(
            currentName,
            nextName,
        );
    }

    async #embeddingProvider(
        configuration: ProjectIndexingProvider,
    ): Promise<EmbeddingProvider> {
        if (configuration.type === "profile") {
            return this.#profiles.createEmbeddingProvider(
                await this.#profiles.get(configuration.profile),
            );
        }
        return this.#profiles.createEmbeddingProvider(configuration.embedding);
    }
}

function settingsFromRequest(
    request: ProjectIndexingRequest,
    target = request.target,
): ProjectIndexingSettings {
    return {
        provider: request.provider,
        ...(target === undefined ? {} : { target }),
        keepReplacedBuilds: request.keepReplacedBuilds,
        ...(request.allowDirty === undefined
            ? {}
            : { allowDirty: request.allowDirty }),
        ...(request.maximumChunkSize === undefined
            ? {}
            : { maximumChunkSize: request.maximumChunkSize }),
        ...(request.windows1251 === undefined
            ? {}
            : { windows1251: request.windows1251 }),
        ...(request.include === undefined ? {} : { include: request.include }),
        ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
    };
}

function settingsFromRecipe(
    recipe: ProjectIndexingRecipe,
): ProjectIndexingSettings {
    return settingsFromRequest({
        root: "",
        provider: recipe.provider,
        ...(recipe.target === undefined ? {} : { target: recipe.target }),
        keepReplacedBuilds: recipe.keepReplacedBuilds,
        ...(recipe.allowDirty === undefined
            ? {}
            : { allowDirty: recipe.allowDirty }),
        ...(recipe.maximumChunkSize === undefined
            ? {}
            : { maximumChunkSize: recipe.maximumChunkSize }),
        ...(recipe.windows1251 === undefined
            ? {}
            : { windows1251: recipe.windows1251 }),
        ...(recipe.include === undefined ? {} : { include: recipe.include }),
        ...(recipe.exclude === undefined ? {} : { exclude: recipe.exclude }),
    });
}

function emit(
    request: ProjectIndexingRequest,
    event: ProjectIndexingEventPayload,
): void {
    request.onEvent?.({
        schemaVersion: PROJECT_INDEXING_EVENT_VERSION,
        timestamp: new Date().toISOString(),
        ...event,
    } as ProjectIndexingEvent);
}

type ProjectIndexingEventPayload =
    ProjectIndexingEvent extends infer Event
        ? Event extends ProjectIndexingEvent
            ? Omit<Event, "schemaVersion" | "timestamp">
            : never
        : never;
