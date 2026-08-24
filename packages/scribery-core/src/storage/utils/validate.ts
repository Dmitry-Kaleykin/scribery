import {
    isFilterableMetadataField,
    type EmbeddingModelIdentity,
} from "../../metadata/index.js";
import type {
    ChunkNeighborhoodRequest,
    DocumentChunksRequest,
    VectorSearchRequest,
} from "../contracts/storage.js";
import { StorageError } from "../errors/storage-error.js";

export function validateVector(
    vector: Float32Array,
    model: EmbeddingModelIdentity,
): void {
    if (
        !(vector instanceof Float32Array) ||
        vector.length !== model.dimensions ||
        vector.some((value) => !Number.isFinite(value))
    ) {
        throw new StorageError(
            "invalid-vector",
            "Stored vector does not match its model identity",
            { dimensions: model.dimensions },
        );
    }
}

export function validateDocumentChunksRequest(
    request: DocumentChunksRequest,
): void {
    if (
        request.indexBuildId.trim().length === 0 ||
        request.path.trim().length === 0
    ) {
        throw new StorageError(
            "invalid-record",
            "Document chunks request requires a build and relative path",
        );
    }
}

export function validateVectorSearchRequest(request: VectorSearchRequest): void {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new StorageError(
            "invalid-record",
            "Vector search limit must be a positive safe integer",
        );
    }

    for (const filter of request.filters ?? []) {
        const values = Array.isArray(filter.value) ? filter.value : [filter.value];

        if (
            !isFilterableMetadataField(filter.field) ||
            !["equals", "in"].includes(filter.operator) ||
            values.length === 0 ||
            values.some((value) =>
                !["string", "number", "boolean"].includes(typeof value) ||
                (typeof value === "number" && !Number.isFinite(value))
            )
        ) {
            throw new StorageError(
                "invalid-record",
                "Vector search contains an invalid metadata filter",
                { field: filter.field },
            );
        }
    }
}

export function validateChunkNeighborhoodRequest(
    request: ChunkNeighborhoodRequest,
): void {
    if (
        request.repositoryId.trim().length === 0 ||
        request.snapshotId.trim().length === 0 ||
        request.indexBuildId.trim().length === 0 ||
        request.documentId.trim().length === 0 ||
        request.anchorChunkId.trim().length === 0 ||
        !Number.isSafeInteger(request.beforeChunks) ||
        request.beforeChunks < 0 ||
        !Number.isSafeInteger(request.afterChunks) ||
        request.afterChunks < 0
    ) {
        throw new StorageError(
            "invalid-record",
            "Chunk neighborhood request contains an invalid scope or limit",
        );
    }
}
