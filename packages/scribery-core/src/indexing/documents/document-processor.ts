import {
    type ChunkingStrategy,
} from "../../chunking/index.js";
import {
    type FileClassification,
} from "../../classification/index.js";
import { type ByteSource } from "../../decoding/index.js";
import {
    EmbeddingService,
    formatDocumentEmbeddingInput,
} from "../../embeddings/index.js";
import {
    METADATA_SCHEMA_VERSION,
    createChunkId,
    createDocumentId,
    createEmbeddingInputId,
    createFileRevisionId,
    hashText,
    normalizeRelativePath,
    type ChunkMetadata,
} from "../../metadata/index.js";
import type {
    PreparedSourceDocument,
    PreparedSourceSnapshot,
} from "../../sources/contracts/source.js";
import {
    normalizeEncodingLabel,
    type EncodingSelection,
    type SupportedEncoding,
} from "../../shared/index.js";
import type {
    StorageProvider,
    StoredChunk,
} from "../../storage/index.js";
import type {
    ResolvedIndexBuildPlan,
} from "../build/contracts/resolved-plan.js";
import { selectSearchableChunks } from "../chunks/select-searchable-chunks.js";
import {
    DEFAULT_CLASSIFICATION_SAMPLE_BYTES,
} from "../constants/build.js";
import type { IndexBuildPlan } from "../contracts/build-engine.js";
import type {
    DocumentProcessingRuntime,
} from "../contracts/document-processing-runtime.js";
import type {
    IndexingDiagnostic,
    IndexingProgress,
    IndexingProgressActivity,
} from "../contracts/coordinator.js";
import type { PendingChunkEmbedding } from "../contracts/pending-chunk.js";
import type { IndexingDecision } from "../contracts/policy.js";
import { IndexingError } from "../errors/indexing-error.js";
import {
    createPreparedDocumentFilterMetadata,
    createPreparedDocumentMetadata,
} from "./metadata.js";
import {
    resolveDocumentEncodingSelection,
} from "./resolve-encoding-selection.js";

export interface DocumentProcessingResult {
    pendingChunks: readonly PendingChunkEmbedding[];
    indexedDocuments: number;
    reusedDocuments: number;
    reusedChunks: number;
}

export interface DocumentProcessingRequest {
    source: PreparedSourceSnapshot;
    indexBuildId: string;
    plan: IndexBuildPlan;
    resolvedPlan: ResolvedIndexBuildPlan;
    runtime: DocumentProcessingRuntime;
    chunkingStrategies: ReadonlyMap<string, ChunkingStrategy>;
    diagnostics: IndexingDiagnostic[];
}

interface PlannedDocument {
    document: PreparedSourceDocument;
    path: string;
    fileRevisionId: string;
    documentId: string;
    encodingSelection: EncodingSelection;
    classification: FileClassification;
    language: string;
    format: string;
    strategyId: Extract<IndexingDecision, { action: "index" }>["strategy"];
    parserId?: string;
    chunkingIdentity: string;
}

export class PreparedDocumentProcessor {
    readonly #storage: StorageProvider;
    readonly #embeddingService: EmbeddingService;

    constructor(
        storage: StorageProvider,
        embeddingService: EmbeddingService,
    ) {
        this.#storage = storage;
        this.#embeddingService = embeddingService;
    }

    async process(
        request: DocumentProcessingRequest,
    ): Promise<DocumentProcessingResult> {
        const { source, plan, resolvedPlan, runtime } = request;
        const { classifier, decoder, parserRegistry } = runtime;
        const pendingChunks: PendingChunkEmbedding[] = [];
        const plannedDocuments: Array<PlannedDocument | undefined> = [];
        let indexedDocuments = 0;
        let reusedDocuments = 0;
        let reusedChunks = 0;

        for (
            let documentIndex = 0;
            documentIndex < source.documents.length;
            documentIndex += 1
        ) {
            const document = source.documents[documentIndex]!;
            plan.signal?.throwIfAborted();
            const path = normalizeRelativePath(document.path);
            const fileRevisionId = createFileRevisionId(
                hashText(document.revisionIdentity),
            );
            const documentId = createDocumentId(
                source.scopeId,
                source.rootIdentity,
                path,
            );
            const encodingSelection = resolveDocumentEncodingSelection(
                document,
                path,
                plan.encodingOverrides ?? [],
                plan.encodingFallback,
            );
            const classification = classifier.classify({
                path,
                byteLength: document.bytes.byteLength,
                sample: document.bytes.subarray(
                    0,
                    DEFAULT_CLASSIFICATION_SAMPLE_BYTES,
                ),
                encodingSelection,
            });
            const language = classification.language ?? "text";
            const format = classification.format ??
                document.fallbackFormat ??
                "plain-text";
            const parser = parserRegistry.resolve({ language, format });
            const decision = plan.policy.evaluate({
                path,
                byteLength: document.bytes.byteLength,
                classification,
                capabilities: { canChunkWithCast: parser !== undefined },
            });

            if (decision.action !== "index") {
                request.diagnostics.push({
                    stage: "policy",
                    path,
                    ...(document.sourceId === undefined
                        ? {}
                        : { sourceId: document.sourceId }),
                    code: decision.reason,
                    message: `Document was not indexed: ${decision.reason}`,
                });
                if (decision.action === "reject") {
                    throw new IndexingError(
                        "indexing-failed",
                        `Indexing policy rejected ${path}`,
                        { path, reason: decision.reason },
                    );
                }
                plannedDocuments.push(undefined);
                continue;
            }

            try {
                if (!plan.strategies.includes(decision.strategy)) {
                    throw new Error(
                        `Policy selected unavailable strategy ${decision.strategy}`,
                    );
                }
                if (decision.strategy === "cast" && parser === undefined) {
                    throw new Error(
                        `No parser is registered for ${language}:${format}`,
                    );
                }
                const parserId = decision.strategy === "cast"
                    ? parser?.id
                    : undefined;
                const chunkingIdentity = decision.strategy === "cast"
                    ? `${resolvedPlan.castChunkingIdentity}:${parserId}`
                    : resolvedPlan.slidingChunkingIdentity;
                plannedDocuments.push({
                    document,
                    path,
                    documentId,
                    fileRevisionId,
                    encodingSelection,
                    classification,
                    language,
                    format,
                    ...(parserId === undefined ? {} : { parserId }),
                    chunkingIdentity,
                    strategyId: decision.strategy,
                });
            } catch (error: unknown) {
                if (plan.signal?.aborted === true) throw error;
                request.diagnostics.push({
                    stage: "processing",
                    path,
                    ...(document.sourceId === undefined
                        ? {}
                        : { sourceId: document.sourceId }),
                    code: errorCode(error),
                    message: `Document processing failed: ${errorMessage(error)}`,
                });
                plannedDocuments.push(undefined);
            }
        }

        const reusable = await this.#storage.reuseDocumentArtifactsMany({
            targetIndexBuildId: request.indexBuildId,
            candidates: plannedDocuments.flatMap((planned) =>
                planned === undefined
                    ? []
                    : [{
                        documentId: planned.documentId,
                        fileRevisionId: planned.fileRevisionId,
                        compatibleEncodings: compatibleEncodingsFor(
                            planned.encodingSelection,
                        ),
                        language: planned.language,
                        format: planned.format,
                        ...(planned.parserId === undefined
                            ? {}
                            : { parserId: planned.parserId }),
                        chunkingIdentity: planned.chunkingIdentity,
                    }]
            ),
        });
        const reusedByDocumentId = new Map(
            reusable.map((reused) => [reused.documentId, reused]),
        );

        for (
            let documentIndex = 0;
            documentIndex < source.documents.length;
            documentIndex += 1
        ) {
            const planned = plannedDocuments[documentIndex];
            const fallbackPath = normalizeRelativePath(
                source.documents[documentIndex]!.path,
            );
            if (planned === undefined) {
                emitDocumentProgress(
                    plan,
                    documentIndex + 1,
                    source.documents.length,
                    fallbackPath,
                    pendingChunks.length,
                    reusedDocuments,
                    reusedChunks,
                );
                continue;
            }

            const reused = reusedByDocumentId.get(planned.documentId);
            if (reused !== undefined) {
                indexedDocuments += 1;
                reusedDocuments += 1;
                reusedChunks += reused.chunkCount;
                emitDocumentProgress(
                    plan,
                    documentIndex + 1,
                    source.documents.length,
                    planned.path,
                    pendingChunks.length,
                    reusedDocuments,
                    reusedChunks,
                );
                continue;
            }

            try {
                const decoded = await decoder.decode({
                    path: planned.path,
                    encodingSelection: planned.encodingSelection,
                    bytes: bytesFrom(planned.document.bytes),
                }, plan.signal === undefined ? {} : { signal: plan.signal });
                const strategy = request.chunkingStrategies.get(
                    planned.strategyId,
                );
                if (strategy === undefined) {
                    throw new Error(
                        `Runtime does not provide strategy ${planned.strategyId}`,
                    );
                }
                emitDocumentProgress(
                    plan,
                    documentIndex,
                    source.documents.length,
                    planned.path,
                    pendingChunks.length,
                    reusedDocuments,
                    reusedChunks,
                    "chunking",
                );
                const chunks = selectSearchableChunks(await strategy.chunk({
                    path: planned.path,
                    content: decoded.content,
                    language: planned.language,
                    format: planned.format,
                }, {
                    maximumSize: resolvedPlan.maximumChunkSize,
                    sizeUnit: "utf16-code-units",
                    ...(plan.signal === undefined
                        ? {}
                        : { signal: plan.signal }),
                }));
                await this.#storage.putDocument(request.indexBuildId, {
                    metadata: createPreparedDocumentMetadata(
                        planned.documentId,
                        planned.fileRevisionId,
                        planned.path,
                        planned.document,
                        decoded.content,
                        decoded.encoding,
                        planned.classification,
                        planned.language,
                        planned.format,
                        planned.parserId,
                    ),
                    content: decoded.content,
                });
                indexedDocuments += 1;

                chunks.forEach((chunk, index) => {
                    const contentHash = hashText(chunk.content);
                    const chunkId = createChunkId({
                        fileRevisionId: planned.fileRevisionId,
                        chunkingIdentity: planned.chunkingIdentity,
                        range: chunk.range,
                        contentHash,
                    });
                    const metadata: ChunkMetadata = {
                        schemaVersion: METADATA_SCHEMA_VERSION,
                        chunkId,
                        fileRevisionId: planned.fileRevisionId,
                        documentId: planned.documentId,
                        index,
                        contentHash,
                        ...chunk.range,
                        chunkingStrategy: chunk.strategy,
                        chunkingIdentity: planned.chunkingIdentity,
                        ...(chunk.kind === undefined
                            ? {}
                            : { kind: chunk.kind }),
                        ...(chunk.semanticContext === undefined
                            ? {}
                            : { semanticContext: chunk.semanticContext }),
                    };
                    const storedChunk: StoredChunk = {
                        metadata,
                        content: chunk.content,
                    };
                    pendingChunks.push({
                        documentId: planned.documentId,
                        chunk: storedChunk,
                        embeddingInput: formatDocumentEmbeddingInput(
                            createEmbeddingInputId(planned.documentId, chunkId),
                            {
                                path: planned.path,
                                language: planned.language,
                                content: chunk.content,
                                ...(chunk.kind === undefined
                                    ? {}
                                    : { kind: chunk.kind }),
                                ...(chunk.semanticContext === undefined
                                    ? {}
                                    : { semanticContext: chunk.semanticContext }),
                            },
                            this.#embeddingService.provider.identity.documentPrefix,
                            this.#embeddingService.provider.identity.embeddingSuffix,
                        ),
                        filterMetadata: createPreparedDocumentFilterMetadata(
                            planned.document,
                            planned.path,
                            planned.language,
                            planned.format,
                            planned.classification.traits,
                            chunk.strategy,
                            chunk.kind,
                            chunk.semanticContext,
                        ),
                    });
                });
            } catch (error: unknown) {
                if (plan.signal?.aborted === true) throw error;
                request.diagnostics.push({
                    stage: "processing",
                    path: planned.path,
                    ...(planned.document.sourceId === undefined
                        ? {}
                        : { sourceId: planned.document.sourceId }),
                    code: errorCode(error),
                    message: `Document processing failed: ${errorMessage(error)}`,
                });
            }

            emitDocumentProgress(
                plan,
                documentIndex + 1,
                source.documents.length,
                planned.path,
                pendingChunks.length,
                reusedDocuments,
                reusedChunks,
            );
        }

        return {
            pendingChunks,
            indexedDocuments,
            reusedDocuments,
            reusedChunks,
        };
    }
}

function emitDocumentProgress(
    plan: IndexBuildPlan,
    completed: number,
    total: number,
    currentPath: string,
    queuedChunks: number,
    reusedDocuments: number,
    reusedChunks: number,
    activity?: IndexingProgressActivity,
): void {
    const progress: IndexingProgress = {
        phase: "processing",
        completed,
        total,
        currentPath,
        queuedChunks,
        reusedDocuments,
        reusedChunks,
        ...(activity === undefined ? {} : { activity }),
    };
    plan.onProgress?.(progress);
}

function bytesFrom(bytes: Uint8Array): ByteSource {
    return { async *read() { yield bytes; } };
}

function compatibleEncodingsFor(
    selection: EncodingSelection,
): readonly SupportedEncoding[] {
    if (selection.override !== undefined) {
        const encoding = normalizeEncodingLabel(selection.override);
        if (encoding === undefined) {
            throw new IndexingError(
                "invalid-configuration",
                `Unsupported encoding override ${selection.override}`,
            );
        }
        return [encoding];
    }

    if (selection.fallback !== undefined) {
        const fallback = normalizeEncodingLabel(selection.fallback);
        if (fallback !== "windows-1251") {
            throw new IndexingError(
                "invalid-configuration",
                `Unsupported encoding fallback ${selection.fallback}`,
            );
        }
        return ["utf-8", fallback];
    }

    return ["utf-8"];
}

function errorCode(error: unknown): string {
    return error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : "processing-failure";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown processing failure";
}
