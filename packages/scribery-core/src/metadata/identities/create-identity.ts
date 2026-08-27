import { createHash } from "node:crypto";

import {
    CONTENT_HASH_ALGORITHM,
    IDENTITY_SCHEMA_VERSION,
} from "../constants/schema.js";
import type {
    ChunkIdentityInput,
    EmbeddingModelIdentity,
} from "../contracts/identity.js";
import { MetadataError } from "../errors/metadata-error.js";

export function createRepositoryId(configuredIdentity: string): string {
    return createIdentity("repository", [configuredIdentity]);
}

export function createDocumentationId(configuredIdentity: string): string {
    return createIdentity("documentation", [configuredIdentity]);
}

export function createSourceId(
    documentationId: string,
    externalIdentity: string,
): string {
    return createIdentity("source", [documentationId, externalIdentity]);
}

export function createSnapshotId(
    repositoryId: string,
    sourceIdentity: string,
    sourceSelectionHash: string,
): string {
    return createIdentity("snapshot", [
        repositoryId,
        sourceIdentity,
        sourceSelectionHash,
    ]);
}

export function createIndexBuildId(
    repositoryId: string,
    snapshotId: string,
    configurationHash: string,
    applicationVersion: string,
): string {
    return createIdentity("index-build", [
        repositoryId,
        snapshotId,
        configurationHash,
        applicationVersion,
    ]);
}

export function createFileRevisionId(byteContentHash: string): string {
    return createIdentity("file-revision", [byteContentHash]);
}

export function createDocumentId(
    repositoryId: string,
    indexingRootIdentity: string,
    normalizedPath: string,
): string {
    return createIdentity("document", [
        repositoryId,
        indexingRootIdentity,
        normalizedPath,
    ]);
}

export function createChunkId(input: ChunkIdentityInput): string {
    return createIdentity("chunk", [
        input.fileRevisionId,
        input.chunkingIdentity,
        input.range.startOffset.toString(),
        input.range.endOffset.toString(),
        input.contentHash,
    ]);
}

export function createEmbeddingId(
    formattedInputHash: string,
    model: EmbeddingModelIdentity,
): string {
    return createIdentity("embedding", [
        formattedInputHash,
        model.provider,
        model.model,
        model.dimensions.toString(),
        model.metric,
        model.revision ?? "",
        model.documentPrefix ?? "",
        model.queryPrefix ?? "",
        ...(model.embeddingSuffix === undefined
            ? []
            : [model.embeddingSuffix]),
    ]);
}

export function createEmbeddingInputId(
    documentId: string,
    chunkId: string,
): string {
    return createIdentity("embedding-input", [documentId, chunkId]);
}

export function createIdentity(
    namespace: string,
    fields: readonly string[],
): string {
    if (!/^[a-z]+(?:-[a-z]+)*$/u.test(namespace)) {
        throw new MetadataError(
            "invalid-identity",
            "Identity namespace must be lowercase kebab-case",
            { namespace },
        );
    }

    const hash = createHash(CONTENT_HASH_ALGORITHM);

    for (const field of [
        namespace,
        IDENTITY_SCHEMA_VERSION.toString(),
        ...fields,
    ]) {
        if (typeof field !== "string") {
            throw new MetadataError(
                "invalid-identity",
                "Identity fields must be strings",
                { namespace },
            );
        }

        const bytes = Buffer.from(field, "utf8");
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(bytes.byteLength);
        hash.update(length);
        hash.update(bytes);
    }

    return `${namespace}_${hash.digest("hex")}`;
}
