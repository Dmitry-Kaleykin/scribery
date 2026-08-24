import type { ChunkingStrategy } from "../chunking/index.js";
import {
    EMBEDDING_FORMATTER_VERSION,
    EmbeddingService,
    type EmbeddingProvider,
} from "../embeddings/index.js";
import {
    CONTENT_HASH_ALGORITHM,
    METADATA_SCHEMA_VERSION,
    createIndexBuildId,
    createSnapshotId,
    hashText,
} from "../metadata/index.js";
import type {
    PreparedSourceSnapshot,
} from "../sources/contracts/source.js";
import type { StorageProvider } from "../storage/index.js";
import {
    resolveIndexBuildPlan,
} from "./build/resolve-plan.js";
import {
    APPLICATION_VERSION,
    CHUNKING_IMPLEMENTATION_VERSION,
    SLIDING_WINDOW_IMPLEMENTATION_VERSION,
} from "./constants/build.js";
import type {
    IndexBuildPlan,
    IndexBuildRequest,
    IndexBuildResult,
} from "./contracts/build-engine.js";
import type {
    DocumentProcessingRuntime,
} from "./contracts/document-processing-runtime.js";
import type { IndexingStrategy } from "./contracts/policy.js";
import type {
    IndexingDiagnostic,
    IndexingProgress,
} from "./contracts/coordinator.js";
import {
    PreparedDocumentProcessor,
} from "./documents/document-processor.js";
import { persistChunkEmbeddings } from "./embeddings/persist-chunk-embeddings.js";
import { IndexingError } from "./errors/indexing-error.js";
import { createArtifactCompatibilityHash } from "./identities/artifact-compatibility.js";

export class IndexBuildEngine {
    readonly #storage: StorageProvider;
    readonly #embeddingService: EmbeddingService;
    readonly #runtime: DocumentProcessingRuntime;

    constructor(
        storage: StorageProvider,
        embeddingProvider: EmbeddingProvider,
        runtime: DocumentProcessingRuntime,
    ) {
        this.#storage = storage;
        this.#embeddingService = new EmbeddingService(embeddingProvider);
        this.#runtime = runtime;
    }

    async build(request: IndexBuildRequest): Promise<IndexBuildResult> {
        const { source, plan } = request;
        const resolvedPlan = resolveIndexBuildPlan(plan);
        const chunkingStrategies = resolveChunkingStrategies(
            this.#runtime,
            plan.strategies,
            resolvedPlan.slidingWindowOverlap,
        );
        const diagnostics: IndexingDiagnostic[] = source.diagnostics.map(
            (diagnostic) => ({
                stage: "discovery",
                ...diagnostic,
            }),
        );
        const snapshotId = createSnapshotId(
            source.scopeId,
            source.sourceIdentity,
            source.sourceSelectionHash,
        );
        const chunkingIdentities = plan.strategies.map((strategy) =>
            strategy === "cast"
                ? resolvedPlan.castChunkingIdentity
                : resolvedPlan.slidingChunkingIdentity
        );
        const artifactCompatibilityHash = createArtifactCompatibilityHash({
            documentProcessingRuntimeIdentity: this.#runtime.identity,
            chunkingIdentities,
            parserIdentities: this.#runtime.parserRegistry.parserIds(),
            modelIdentity: this.#embeddingService.provider.identity,
        });
        const configurationHash = hashText(JSON.stringify({
            applicationVersion: APPLICATION_VERSION,
            documentProcessingRuntimeIdentity: this.#runtime.identity,
            artifactCompatibilityHash,
            policyIdentity: plan.policyIdentity,
            strategies: [...plan.strategies].sort(),
            chunkingImplementationVersion: CHUNKING_IMPLEMENTATION_VERSION,
            slidingWindowImplementationVersion:
                SLIDING_WINDOW_IMPLEMENTATION_VERSION,
            embeddingFormatterVersion: EMBEDDING_FORMATTER_VERSION,
            maximumChunkSize: resolvedPlan.maximumChunkSize,
            slidingWindowOverlap: resolvedPlan.slidingWindowOverlap,
            encodingFallback: plan.encodingFallback ?? null,
            encodingOverrides: plan.encodingOverrides ?? [],
            modelIdentity: this.#embeddingService.provider.identity,
            hashAlgorithm: CONTENT_HASH_ALGORITHM,
            metadataSchemaVersion: METADATA_SCHEMA_VERSION,
        }));
        const indexBuildId = createIndexBuildId(
            source.scopeId,
            snapshotId,
            configurationHash,
            APPLICATION_VERSION,
        );
        const existingBuild = await this.#storage.getBuild(indexBuildId);

        if (existingBuild?.status === "ready") {
            emitProgress(plan, {
                phase: "complete",
                discoveredFiles: source.documents.length,
                reusedBuild: true,
            });
            return {
                repositoryId: source.scopeId,
                snapshotId,
                indexBuildId,
                discoveredFiles: source.documents.length,
                indexedDocuments: 0,
                indexedChunks: 0,
                diagnostics,
                reused: true,
                reusedDocuments: 0,
                reusedChunks: 0,
                reusedEmbeddings: 0,
                generatedEmbeddings: 0,
            };
        }

        if (existingBuild !== undefined) {
            throw new IndexingError(
                "build-exists",
                `Index build ${indexBuildId} already exists with status ${existingBuild.status}`,
                { indexBuildId, status: existingBuild.status },
            );
        }

        let beganBuild = false;

        try {
            emitProgress(plan, { phase: "preparing-build" });
            await this.#storage.beginBuild({
                indexBuildId,
                repositoryId: source.scopeId,
                snapshotId,
                sourceIdentity: source.sourceIdentity,
                sourceProvenance: source.provenance,
                configurationHash,
                artifactCompatibilityHash,
                modelIdentity: this.#embeddingService.provider.identity,
                status: "building",
                createdAt: new Date().toISOString(),
            });
            beganBuild = true;
            emitProgress(plan, {
                phase: "processing",
                completed: 0,
                total: source.documents.length,
                queuedChunks: 0,
                reusedDocuments: 0,
                reusedChunks: 0,
            });
            const processing = await new PreparedDocumentProcessor(
                this.#storage,
                this.#embeddingService,
            ).process({
                source,
                indexBuildId,
                plan,
                resolvedPlan,
                runtime: this.#runtime,
                chunkingStrategies,
                diagnostics,
            });
            emitProgress(plan, {
                phase: "embedding",
                completed: 0,
                total: processing.pendingChunks.length,
                queuedChunks: processing.pendingChunks.length,
                reusedDocuments: processing.reusedDocuments,
                reusedChunks: processing.reusedChunks,
            });
            const persistence = await persistChunkEmbeddings({
                storage: this.#storage,
                indexBuildId,
                pendingChunks: processing.pendingChunks,
                embeddingService: this.#embeddingService,
                ...(plan.maximumEmbeddingInputsPerBatch === undefined
                    ? {}
                    : {
                        maximumInputsPerBatch:
                            plan.maximumEmbeddingInputsPerBatch,
                    }),
                ...(plan.signal === undefined ? {} : { signal: plan.signal }),
                onProgress: (progress) => emitProgress(plan, {
                    phase: "embedding",
                    completed: progress.completedChunks,
                    total: progress.totalChunks,
                    queuedChunks: processing.pendingChunks.length,
                    reusedDocuments: processing.reusedDocuments,
                    reusedChunks: processing.reusedChunks,
                    reusedEmbeddings: progress.reusedEmbeddings,
                    generatedEmbeddings: progress.generatedEmbeddings,
                }),
            });
            emitProgress(plan, {
                phase: "storage",
                completed: persistence.storedChunks,
                total: processing.pendingChunks.length,
            });
            emitProgress(plan, { phase: "finalizing" });
            await this.#storage.setBuildStatus(
                indexBuildId,
                "ready",
                new Date().toISOString(),
            );
            const result: IndexBuildResult = {
                repositoryId: source.scopeId,
                snapshotId,
                indexBuildId,
                discoveredFiles: source.documents.length,
                indexedDocuments: processing.indexedDocuments,
                indexedChunks:
                    processing.reusedChunks + processing.pendingChunks.length,
                diagnostics,
                reused: false,
                reusedDocuments: processing.reusedDocuments,
                reusedChunks: processing.reusedChunks,
                reusedEmbeddings: persistence.reusedEmbeddings,
                generatedEmbeddings: persistence.generatedEmbeddings,
            };
            emitProgress(plan, {
                phase: "complete",
                discoveredFiles: result.discoveredFiles,
                queuedChunks: result.indexedChunks,
                reusedDocuments: result.reusedDocuments,
                reusedChunks: result.reusedChunks,
                reusedEmbeddings: result.reusedEmbeddings,
                generatedEmbeddings: result.generatedEmbeddings,
            });
            return result;
        } catch (error: unknown) {
            if (beganBuild) {
                await this.#storage.setBuildStatus(
                    indexBuildId,
                    plan.signal?.aborted === true ? "cancelled" : "failed",
                    new Date().toISOString(),
                ).catch(() => {});
            }
            if (error instanceof IndexingError) throw error;
            throw new IndexingError(
                plan.signal?.aborted === true
                    ? "cancelled"
                    : "indexing-failed",
                `Index build failed for ${sourceLabel(source)}`,
                { indexBuildId },
                error,
            );
        }
    }
}

function resolveChunkingStrategies(
    runtime: DocumentProcessingRuntime,
    requiredStrategies: readonly IndexingStrategy[],
    slidingWindowOverlap: number,
): ReadonlyMap<string, ChunkingStrategy> {
    if (runtime.identity.trim().length === 0) {
        throw new IndexingError(
            "invalid-configuration",
            "Document processing runtime identity must not be empty",
        );
    }

    const strategies = new Map<string, ChunkingStrategy>();
    for (const strategy of runtime.createChunkingStrategies({
        slidingWindowOverlap,
    })) {
        if (strategies.has(strategy.id)) {
            throw new IndexingError(
                "invalid-configuration",
                `Document processing runtime provides duplicate strategy ${strategy.id}`,
            );
        }
        strategies.set(strategy.id, strategy);
    }

    for (const strategy of requiredStrategies) {
        if (!strategies.has(strategy)) {
            throw new IndexingError(
                "invalid-configuration",
                `Document processing runtime does not provide strategy ${strategy}`,
            );
        }
    }

    return strategies;
}

function emitProgress(plan: IndexBuildPlan, progress: IndexingProgress): void {
    plan.onProgress?.(progress);
}

function sourceLabel(source: PreparedSourceSnapshot): string {
    if (source.provenance.kind === "managed-collection") {
        return `collection ${source.provenance.collectionId}`;
    }
    return source.provenance.root;
}
