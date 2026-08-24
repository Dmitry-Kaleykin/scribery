import { EmbeddingService } from "../../embeddings/index.js";
import {
    createEmbeddingId,
    hashText,
} from "../../metadata/index.js";
import type {
    ChunkEmbeddingWrite,
    StorageProvider,
} from "../../storage/index.js";
import type { PendingChunkEmbedding } from "../contracts/pending-chunk.js";
import { IndexingError } from "../errors/indexing-error.js";

interface PreparedChunkEmbedding extends PendingChunkEmbedding {
    embeddingId: string;
    inputHash: string;
}

interface MissingEmbeddingGroup {
    input: PendingChunkEmbedding["embeddingInput"];
    chunks: PreparedChunkEmbedding[];
}

export interface PersistChunkEmbeddingsOptions {
    storage: StorageProvider;
    indexBuildId: string;
    pendingChunks: readonly PendingChunkEmbedding[];
    embeddingService: EmbeddingService;
    maximumInputsPerBatch?: number;
    signal?: AbortSignal;
    onProgress?: (progress: {
        completedChunks: number;
        totalChunks: number;
        reusedEmbeddings: number;
        generatedEmbeddings: number;
    }) => void;
}

export interface PersistChunkEmbeddingsResult {
    storedChunks: number;
    reusedEmbeddings: number;
    generatedEmbeddings: number;
}

export async function persistChunkEmbeddings(
    options: PersistChunkEmbeddingsOptions,
): Promise<PersistChunkEmbeddingsResult> {
    const modelIdentity = options.embeddingService.provider.identity;
    const prepared = options.pendingChunks.map((pending): PreparedChunkEmbedding => {
        const inputHash = hashText(pending.embeddingInput.text);
        return {
            ...pending,
            inputHash,
            embeddingId: createEmbeddingId(inputHash, modelIdentity),
        };
    });
    const reused = await options.storage.reuseChunkEmbeddings(
        options.indexBuildId,
        prepared.map((pending) => ({
            documentId: pending.documentId,
            chunk: pending.chunk,
            embeddingId: pending.embeddingId,
            inputHash: pending.inputHash,
            filterMetadata: pending.filterMetadata,
        })),
    );
    const reusedKeys = new Set(reused.map(({ documentId, chunkId }) =>
        chunkKey(documentId, chunkId)
    ));
    const missingGroups = new Map<string, MissingEmbeddingGroup>();

    for (const pending of prepared) {
        if (reusedKeys.has(chunkKey(
            pending.documentId,
            pending.chunk.metadata.chunkId,
        ))) {
            continue;
        }

        const existing = missingGroups.get(pending.embeddingId);
        if (existing === undefined) {
            missingGroups.set(pending.embeddingId, {
                input: { ...pending.embeddingInput, id: pending.embeddingId },
                chunks: [pending],
            });
        } else {
            if (existing.input.text !== pending.embeddingInput.text) {
                throw new IndexingError(
                    "indexing-failed",
                    "Content-addressed embedding inputs are inconsistent",
                    { embeddingId: pending.embeddingId },
                );
            }
            existing.chunks.push(pending);
        }
    }

    let completedChunks = reused.length;
    let generatedEmbeddings = 0;
    emitProgress(options, completedChunks, prepared.length, reused.length, 0);
    const groups = [...missingGroups.values()];

    for await (const batch of options.embeddingService.embedBatches(
        groups.map(({ input }) => input),
        {
            ...(options.maximumInputsPerBatch === undefined
                ? {}
                : { maximumInputsPerBatch: options.maximumInputsPerBatch }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
    )) {
        const writes: ChunkEmbeddingWrite[] = [];

        for (const result of batch.results) {
            const group = missingGroups.get(result.id);
            if (group === undefined) {
                throw new IndexingError(
                    "indexing-failed",
                    "Embedding batch returned an unknown content identity",
                    { embeddingId: result.id },
                );
            }

            for (const pending of group.chunks) {
                writes.push({
                    documentId: pending.documentId,
                    chunk: pending.chunk,
                    embedding: {
                        embeddingId: pending.embeddingId,
                        inputHash: pending.inputHash,
                        modelIdentity,
                        vector: result.vector,
                    },
                    filterMetadata: pending.filterMetadata,
                });
            }
        }

        await options.storage.putChunkEmbeddings(options.indexBuildId, writes);
        completedChunks += writes.length;
        generatedEmbeddings += batch.results.length;
        emitProgress(
            options,
            completedChunks,
            prepared.length,
            reused.length,
            generatedEmbeddings,
        );
    }

    if (completedChunks !== prepared.length) {
        throw new IndexingError(
            "indexing-failed",
            "Embedding stream ended before every chunk was stored",
            { completedChunks, pendingChunks: prepared.length },
        );
    }

    return {
        storedChunks: completedChunks,
        reusedEmbeddings: reused.length,
        generatedEmbeddings,
    };
}

function emitProgress(
    options: PersistChunkEmbeddingsOptions,
    completedChunks: number,
    totalChunks: number,
    reusedEmbeddings: number,
    generatedEmbeddings: number,
): void {
    options.onProgress?.({
        completedChunks,
        totalChunks,
        reusedEmbeddings,
        generatedEmbeddings,
    });
}

function chunkKey(documentId: string, chunkId: string): string {
    return `${documentId}\0${chunkId}`;
}
