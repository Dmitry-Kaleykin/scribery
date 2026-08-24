import {
    CONTENT_HASH_ALGORITHM,
    METADATA_SCHEMA_VERSION,
} from "../constants/schema.js";
import { isFilterableMetadataField } from "../constants/filter-fields.js";
import type {
    ChunkMetadata,
    DocumentMetadata,
    FilterMetadata,
} from "../contracts/records.js";
import { MetadataError } from "../errors/metadata-error.js";
import { normalizeRelativePath } from "../paths/normalize-relative-path.js";

const HASH_PATTERN = new RegExp(
    `^${CONTENT_HASH_ALGORITHM}:[a-f0-9]{64}$`,
    "u",
);

export function validateDocumentMetadata(metadata: DocumentMetadata): void {
    validateSchema(metadata.schemaVersion, metadata.documentId);

    if (normalizeRelativePath(metadata.path) !== metadata.path) {
        throw invalidMetadata("Document path is not normalized", metadata.documentId);
    }

    validateHash(metadata.byteContentHash, metadata.documentId);
    validateHash(metadata.decodedContentHash, metadata.documentId);

    if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0) {
        throw invalidMetadata("Document byte length is invalid", metadata.documentId);
    }

    if (
        !Number.isFinite(metadata.classificationConfidence) ||
        metadata.classificationConfidence < 0 ||
        metadata.classificationConfidence > 1
    ) {
        throw invalidMetadata(
            "Document classification confidence is invalid",
            metadata.documentId,
        );
    }

    if (
        metadata.parserId !== undefined &&
        (typeof metadata.parserId !== "string" ||
            metadata.parserId.trim().length === 0)
    ) {
        throw invalidMetadata(
            "Document parser ID must not be empty",
            metadata.documentId,
        );
    }

    for (const [field, value] of [
        ["sourceId", metadata.sourceId],
        ["title", metadata.title],
        ["mediaType", metadata.mediaType],
    ] as readonly (readonly [string, unknown])[]) {
        if (
            value !== undefined &&
            (typeof value !== "string" || value.trim().length === 0)
        ) {
            throw invalidMetadata(
                `Document ${field} must not be empty`,
                metadata.documentId,
            );
        }
    }

    if (
        metadata.tags !== undefined &&
        (!Array.isArray(metadata.tags) ||
            metadata.tags.some((tag) =>
                typeof tag !== "string" || tag.trim().length === 0
            ))
    ) {
        throw invalidMetadata("Document tags are invalid", metadata.documentId);
    }

    if (metadata.sourceAttributes !== undefined) {
        for (const [key, value] of Object.entries(metadata.sourceAttributes)) {
            if (
                key.trim().length === 0 ||
                !["string", "number", "boolean"].includes(typeof value) ||
                (typeof value === "string" && value.trim().length === 0) ||
                (typeof value === "number" && !Number.isFinite(value))
            ) {
                throw invalidMetadata(
                    "Document source attributes are invalid",
                    metadata.documentId,
                );
            }
        }
    }
}

export function validateChunkMetadata(metadata: ChunkMetadata): void {
    validateSchema(metadata.schemaVersion, metadata.chunkId);
    validateHash(metadata.contentHash, metadata.chunkId);

    if (!Number.isSafeInteger(metadata.index) || metadata.index < 0) {
        throw invalidMetadata("Chunk index is invalid", metadata.chunkId);
    }

    if (
        !Number.isSafeInteger(metadata.startOffset) ||
        !Number.isSafeInteger(metadata.endOffset) ||
        metadata.startOffset < 0 ||
        metadata.endOffset <= metadata.startOffset ||
        !Number.isSafeInteger(metadata.startLine) ||
        !Number.isSafeInteger(metadata.endLine) ||
        metadata.startLine < 1 ||
        metadata.endLine < metadata.startLine
    ) {
        throw invalidMetadata("Chunk source range is invalid", metadata.chunkId);
    }
}

export function validateFilterMetadata(metadata: FilterMetadata): void {
    for (const [field, value] of Object.entries(metadata)) {
        const values = Array.isArray(value) ? value : [value];

        if (
            !isFilterableMetadataField(field) ||
            values.some((item) =>
                !["string", "number", "boolean"].includes(typeof item) ||
                (typeof item === "number" && !Number.isFinite(item))
            )
        ) {
            throw new MetadataError(
                "invalid-metadata",
                "Filter metadata contains an unsupported value",
                { field },
            );
        }
    }
}

function validateSchema(schemaVersion: number, recordId: string): void {
    if (schemaVersion !== METADATA_SCHEMA_VERSION) {
        throw new MetadataError(
            "unsupported-schema",
            `Metadata schema ${schemaVersion} is not supported`,
            { recordId, schemaVersion },
        );
    }
}

function validateHash(hash: string, recordId: string): void {
    if (!HASH_PATTERN.test(hash)) {
        throw new MetadataError(
            "invalid-hash",
            "Metadata content hash is invalid",
            { recordId },
        );
    }
}

function invalidMetadata(message: string, recordId: string): MetadataError {
    return new MetadataError("invalid-metadata", message, { recordId });
}
