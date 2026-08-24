import {
    DEFAULT_MAXIMUM_CHUNK_SIZE,
    DEFAULT_SLIDING_WINDOW_OVERLAP,
    IndexBuildEngine,
    SqliteStorageProvider,
    hashText,
    type EmbeddingProvider,
} from "scribery-core";
import { TextAndCodeIndexingPolicy } from "../../indexing/index.js";
import type {
    CollectionBuildOptions,
    CollectionBuildProgress,
    CollectionBuildResult,
    CollectionManifest,
} from "../contracts/collection.js";
import { CollectionError } from "../errors/collection-error.js";
import { CollectionCatalog } from "../managed/catalog.js";
import { collectionDatabasePath } from "../managed/paths.js";
import {
    ManagedCollectionSourceProvider,
} from "../sources/managed-collection-source.js";

export class CollectionIndexer {
    readonly #catalog: CollectionCatalog;
    readonly #provider: EmbeddingProvider;
    readonly #sources: ManagedCollectionSourceProvider;

    constructor(catalog: CollectionCatalog, provider: EmbeddingProvider) {
        this.#catalog = catalog;
        this.#provider = provider;
        this.#sources = new ManagedCollectionSourceProvider(catalog);
    }

    async build(
        reference: string,
        options: CollectionBuildOptions = {},
    ): Promise<CollectionBuildResult> {
        const resolved = resolveOptions(options);
        const manifest = await this.#catalog.resolve(reference);
        const source = await this.#sources.prepare({
            manifest,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const databasePath = collectionDatabasePath(
            this.#catalog.baseDirectory,
            manifest.collectionId,
        );
        const storage = new SqliteStorageProvider(databasePath);

        try {
            const result = await new IndexBuildEngine(
                storage,
                this.#provider,
            ).build({
                source,
                plan: {
                    policy: new TextAndCodeIndexingPolicy({
                        ...(options.maximumFileByteLength === undefined
                            ? {}
                            : {
                                maxByteLength:
                                    options.maximumFileByteLength,
                            }),
                    }),
                    policyIdentity: textAndCodePolicyIdentity(
                        options.maximumFileByteLength,
                    ),
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
                    ...(options.signal === undefined
                        ? {}
                        : { signal: options.signal }),
                    onProgress: (progress) => emitProgress(
                        options,
                        manifest,
                        progress,
                    ),
                },
            });
            const completedAt = new Date().toISOString();
            await this.#activateBuild(
                manifest,
                completedAt,
                {
                    repositoryId: result.repositoryId,
                    snapshotId: result.snapshotId,
                    indexBuildId: result.indexBuildId,
                },
            );

            return {
                collectionId: manifest.collectionId,
                databasePath,
                repositoryId: result.repositoryId,
                snapshotId: result.snapshotId,
                indexBuildId: result.indexBuildId,
                sourceCount: source.documents.length,
                indexedDocuments: result.indexedDocuments,
                indexedChunks: result.indexedChunks,
                reusedDocuments: result.reusedDocuments,
                reusedChunks: result.reusedChunks,
                reusedEmbeddings: result.reusedEmbeddings,
                generatedEmbeddings: result.generatedEmbeddings,
                reusedBuild: result.reused,
                diagnostics: result.diagnostics.map((diagnostic) => ({
                    sourceId: diagnostic.sourceId ??
                        sourceIdForPath(
                            manifest,
                            diagnostic.path,
                        ) ??
                        "",
                    logicalPath: diagnostic.path,
                    code: diagnostic.code,
                    message: diagnostic.message,
                })),
            };
        } finally {
            await storage.close();
        }
    }

    async #activateBuild(
        manifest: CollectionManifest,
        completedAt: string,
        build: {
            repositoryId: string;
            snapshotId: string;
            indexBuildId: string;
        },
    ): Promise<void> {
        const current = await this.#catalog.resolve(manifest.collectionId);

        if (current.sourcesRevision !== manifest.sourcesRevision) {
            throw new CollectionError(
                "build-required",
                "Collection sources changed while the build was running",
                {
                    collectionId: manifest.collectionId,
                    builtRevision: manifest.sourcesRevision,
                    currentRevision: current.sourcesRevision,
                },
            );
        }

        await this.#catalog.write({
            ...current,
            updatedAt: new Date().toISOString(),
            builtSourcesRevision: current.sourcesRevision,
            activeBuild: { ...build, completedAt },
        });
    }
}

function resolveOptions(options: CollectionBuildOptions): {
    maximumChunkSize: number;
    slidingWindowOverlap: number;
} {
    const maximumChunkSize = options.maximumChunkSize ??
        DEFAULT_MAXIMUM_CHUNK_SIZE;
    const slidingWindowOverlap = options.slidingWindowOverlap ?? Math.min(
        DEFAULT_SLIDING_WINDOW_OVERLAP,
        Math.floor(maximumChunkSize / 5),
    );

    if (
        !Number.isSafeInteger(maximumChunkSize) ||
        maximumChunkSize < 1 ||
        !Number.isSafeInteger(slidingWindowOverlap) ||
        slidingWindowOverlap < 0 ||
        slidingWindowOverlap >= maximumChunkSize
    ) {
        throw new CollectionError(
            "invalid-collection",
            "Collection chunk size and overlap are invalid",
            { maximumChunkSize, overlap: slidingWindowOverlap },
        );
    }

    return { maximumChunkSize, slidingWindowOverlap };
}

function textAndCodePolicyIdentity(
    maximumFileByteLength: number | undefined,
): string {
    return `text-and-code:${hashText(JSON.stringify({
        maximumFileByteLength: maximumFileByteLength ?? null,
    }))}`;
}

function emitProgress(
    options: CollectionBuildOptions,
    manifest: CollectionManifest,
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
    const phase = collectionProgressPhase(progress.phase);
    if (phase === undefined) return;
    const currentSourceId = progress.currentPath === undefined
        ? undefined
        : sourceIdForPath(manifest, progress.currentPath);
    const event: CollectionBuildProgress = {
        phase,
        completed: progress.completed ??
            progress.discoveredFiles ??
            (phase === "complete" ? manifest.sources.length : 0),
        total: progress.total ?? manifest.sources.length,
        ...(currentSourceId === undefined ? {} : { currentSourceId }),
        ...(progress.reusedDocuments === undefined
            ? {}
            : { reusedDocuments: progress.reusedDocuments }),
        ...(progress.reusedChunks === undefined
            ? {}
            : { reusedChunks: progress.reusedChunks }),
        ...(progress.reusedEmbeddings === undefined
            ? {}
            : { reusedEmbeddings: progress.reusedEmbeddings }),
        ...(progress.generatedEmbeddings === undefined
            ? {}
            : { generatedEmbeddings: progress.generatedEmbeddings }),
    };
    options.onProgress?.(event);
}

function collectionProgressPhase(
    phase: string,
): CollectionBuildProgress["phase"] | undefined {
    if (phase === "processing" || phase === "embedding" || phase === "complete") {
        return phase;
    }
    if (phase === "finalizing" || phase === "storage") return "finalizing";
    return undefined;
}

function sourceIdForPath(
    manifest: CollectionManifest,
    path: string,
): string | undefined {
    return manifest.sources.find(({ logicalPath }) => logicalPath === path)
        ?.sourceId;
}
