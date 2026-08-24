import { EMBEDDING_FORMATTER_VERSION } from "../../embeddings/index.js";
import {
    CONTENT_HASH_ALGORITHM,
    METADATA_SCHEMA_VERSION,
    hashText,
    type EmbeddingModelIdentity,
} from "../../metadata/index.js";
import { ARTIFACT_COMPATIBILITY_VERSION } from "../constants/build.js";

export interface ArtifactCompatibilityIdentityInput {
    chunkingIdentities: readonly string[];
    parserIdentities: readonly string[];
    modelIdentity: EmbeddingModelIdentity;
}

export function createArtifactCompatibilityHash(
    input: ArtifactCompatibilityIdentityInput,
): string {
    const model = input.modelIdentity;

    return hashText(JSON.stringify({
        version: ARTIFACT_COMPATIBILITY_VERSION,
        chunkingIdentities: [...new Set(input.chunkingIdentities)].sort(),
        parserIdentities: [...new Set(input.parserIdentities)].sort(),
        embeddingFormatterVersion: EMBEDDING_FORMATTER_VERSION,
        modelIdentity: {
            provider: model.provider,
            model: model.model,
            dimensions: model.dimensions,
            metric: model.metric,
            revision: model.revision ?? null,
            documentPrefix: model.documentPrefix ?? null,
            queryPrefix: model.queryPrefix ?? null,
            embeddingSuffix: model.embeddingSuffix ?? null,
        },
        hashAlgorithm: CONTENT_HASH_ALGORITHM,
        metadataSchemaVersion: METADATA_SCHEMA_VERSION,
    }));
}
