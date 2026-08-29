import {
    DEFAULT_MAXIMUM_CHUNK_SIZE,
    DEFAULT_SLIDING_WINDOW_OVERLAP,
    IndexBuildEngine,
    SqliteStorageProvider,
    hashText,
    type EmbeddingProvider,
} from "scribery-core";
import { TextAndCodeIndexingPolicy } from "../../indexing/index.js";
import { createDocumentsProcessingRuntime } from "../../indexing/runtime.js";
import type {
    DocumentationIndexOptions,
    DocumentationIndexProgress,
    DocumentationIndexResult,
    DocumentationManifest,
    IndexedDocumentationSource,
} from "../contracts/documentation.js";
import { DocumentationError } from "../errors/documentation-error.js";
import { DocumentationCatalog } from "../managed/catalog.js";
import { documentationDatabasePath } from "../managed/paths.js";
import { DocumentationSourceProvider } from "../sources/documentation-source.js";

export class DocumentationIndexer {
    readonly #catalog: DocumentationCatalog;
    readonly #provider: EmbeddingProvider;
    readonly #sources: DocumentationSourceProvider;

    constructor(catalog: DocumentationCatalog, provider: EmbeddingProvider) {
        this.#catalog = catalog;
        this.#provider = provider;
        this.#sources = new DocumentationSourceProvider(catalog);
    }

    async index(
        reference: string,
        options: DocumentationIndexOptions = {},
    ): Promise<DocumentationIndexResult> {
        const resolved = resolveOptions(options);
        const manifest = await this.#catalog.resolve(reference);
        const prepared = await this.#sources.prepare({
            manifest,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const databasePath = documentationDatabasePath(
            this.#catalog.baseDirectory,
            manifest.documentationId,
        );
        const storage = new SqliteStorageProvider(databasePath);

        try {
            const result = await new IndexBuildEngine(
                storage,
                this.#provider,
                createDocumentsProcessingRuntime(),
            ).build({
                source: prepared.source,
                plan: {
                    policy: new TextAndCodeIndexingPolicy({
                        ...(options.maximumFileByteLength === undefined
                            ? {}
                            : { maxByteLength: options.maximumFileByteLength }),
                    }),
                    policyIdentity: textAndCodePolicyIdentity(options.maximumFileByteLength),
                    strategies: ["cast", "sliding-window"],
                    maximumChunkSize: resolved.maximumChunkSize,
                    slidingWindowOverlap: resolved.slidingWindowOverlap,
                    ...(options.maximumEmbeddingInputsPerBatch === undefined
                        ? {}
                        : {
                            maximumEmbeddingInputsPerBatch:
                                options.maximumEmbeddingInputsPerBatch,
                        }),
                    ...(options.encodingFallback === undefined
                        ? {}
                        : { encodingFallback: options.encodingFallback }),
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                    onProgress: (progress) => emitProgress(
                        options,
                        prepared.indexedSources.length,
                        progress,
                    ),
                },
            });
            const completedAt = new Date().toISOString();
            await this.#activateIndex(
                manifest,
                prepared.indexedSources,
                completedAt,
                {
                    repositoryId: result.repositoryId,
                    snapshotId: result.snapshotId,
                    indexBuildId: result.indexBuildId,
                },
            );

            const sourceIdByPath = new Map(
                prepared.indexedSources.map((source) => [source.logicalPath, source.sourceId]),
            );
            return {
                documentationId: manifest.documentationId,
                databasePath,
                repositoryId: result.repositoryId,
                snapshotId: result.snapshotId,
                indexBuildId: result.indexBuildId,
                sourceCount: prepared.indexedSources.length,
                indexedDocuments: result.indexedDocuments,
                indexedChunks: result.indexedChunks,
                reusedDocuments: result.reusedDocuments,
                reusedChunks: result.reusedChunks,
                reusedEmbeddings: result.reusedEmbeddings,
                generatedEmbeddings: result.generatedEmbeddings,
                reusedBuild: result.reused,
                diagnostics: result.diagnostics.map((diagnostic) => ({
                    sourceId: diagnostic.sourceId ?? sourceIdByPath.get(diagnostic.path) ?? "",
                    logicalPath: diagnostic.path,
                    code: diagnostic.code,
                    message: diagnostic.message,
                })),
            };
        } finally {
            await storage.close();
        }
    }

    async #activateIndex(
        manifest: DocumentationManifest,
        indexedSources: readonly IndexedDocumentationSource[],
        completedAt: string,
        build: { repositoryId: string; snapshotId: string; indexBuildId: string },
    ): Promise<void> {
        const current = await this.#catalog.resolve(manifest.documentationId);
        if (current.configurationRevision !== manifest.configurationRevision) {
            throw new DocumentationError(
                "index-required",
                "Documentation source configuration changed while indexing was running",
                {
                    documentationId: manifest.documentationId,
                    indexedRevision: manifest.configurationRevision,
                    currentRevision: current.configurationRevision,
                },
            );
        }
        await this.#catalog.write({
            ...current,
            updatedAt: new Date().toISOString(),
            activeBuild: {
                ...build,
                configurationRevision: current.configurationRevision,
                indexedSources,
                completedAt,
            },
        });
    }
}

function resolveOptions(options: DocumentationIndexOptions): {
    maximumChunkSize: number;
    slidingWindowOverlap: number;
} {
    const maximumChunkSize = options.maximumChunkSize ?? DEFAULT_MAXIMUM_CHUNK_SIZE;
    const slidingWindowOverlap = options.slidingWindowOverlap ?? Math.min(
        DEFAULT_SLIDING_WINDOW_OVERLAP,
        Math.floor(maximumChunkSize / 5),
    );
    if (
        !Number.isSafeInteger(maximumChunkSize) || maximumChunkSize < 1 ||
        !Number.isSafeInteger(slidingWindowOverlap) || slidingWindowOverlap < 0 ||
        slidingWindowOverlap >= maximumChunkSize
    ) {
        throw new DocumentationError(
            "invalid-documentation",
            "Documentation chunk size and overlap are invalid",
            { maximumChunkSize, overlap: slidingWindowOverlap },
        );
    }
    return { maximumChunkSize, slidingWindowOverlap };
}

function textAndCodePolicyIdentity(maximumFileByteLength: number | undefined): string {
    return `text-and-code:${hashText(JSON.stringify({
        maximumFileByteLength: maximumFileByteLength ?? null,
    }))}`;
}

function emitProgress(
    options: DocumentationIndexOptions,
    sourceCount: number,
    progress: {
        phase: string;
        completed?: number;
        total?: number;
        currentPath?: string;
        discoveredFiles?: number;
        reusedDocuments?: number;
        reusedChunks?: number;
        reusedEmbeddings?: number;
        generatedEmbeddings?: number;
    },
): void {
    const phase = documentationProgressPhase(progress.phase);
    if (phase === undefined) return;
    const event: DocumentationIndexProgress = {
        phase,
        completed: progress.completed ?? progress.discoveredFiles ??
            (phase === "complete" ? sourceCount : 0),
        total: progress.total ?? sourceCount,
        ...(progress.currentPath === undefined ? {} : { currentPath: progress.currentPath }),
        ...(progress.reusedDocuments === undefined
            ? {}
            : { reusedDocuments: progress.reusedDocuments }),
        ...(progress.reusedChunks === undefined ? {} : { reusedChunks: progress.reusedChunks }),
        ...(progress.reusedEmbeddings === undefined
            ? {}
            : { reusedEmbeddings: progress.reusedEmbeddings }),
        ...(progress.generatedEmbeddings === undefined
            ? {}
            : { generatedEmbeddings: progress.generatedEmbeddings }),
    };
    options.onProgress?.(event);
}

function documentationProgressPhase(
    phase: string,
): DocumentationIndexProgress["phase"] | undefined {
    if (phase === "processing" || phase === "embedding" || phase === "complete") {
        return phase;
    }
    if (phase === "finalizing" || phase === "storage") return "finalizing";
    return undefined;
}
