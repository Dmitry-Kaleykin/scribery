export {
    CONTENT_HASH_ALGORITHM,
    IDENTITY_SCHEMA_VERSION,
    METADATA_SCHEMA_VERSION,
} from "./constants/schema.js";
export {
    FILTERABLE_METADATA_FIELDS,
    isFilterableMetadataField,
    type FilterableMetadataField,
} from "./constants/filter-fields.js";
export type {
    ChunkIdentityInput,
    EmbeddingModelIdentity,
} from "./contracts/identity.js";
export type {
    ChunkMetadata,
    DocumentMetadata,
    FilterMetadata,
    FilterValue,
} from "./contracts/records.js";
export type {
    ChunkSemanticContext,
    CodeImportReference,
    CodeSymbolReference,
    SyntaxImport,
    SyntaxSymbol,
} from "./contracts/code-context.js";
export type {
    SourceRange,
    SourceSlice,
} from "./contracts/source-position.js";
export {
    MetadataError,
    type MetadataErrorCode,
} from "./errors/metadata-error.js";
export {
    SourcePositionError,
    type SourcePositionErrorCode,
} from "./errors/source-position-error.js";
export { hashBytes, hashText } from "./hashing/content-hash.js";
export {
    createChunkId,
    createDocumentationId,
    createDocumentId,
    createEmbeddingId,
    createEmbeddingInputId,
    createFileRevisionId,
    createIdentity,
    createIndexBuildId,
    createRepositoryId,
    createSnapshotId,
    createSourceId,
} from "./identities/create-identity.js";
export { normalizeRelativePath } from "./paths/normalize-relative-path.js";
export { SourcePositionIndex } from "./source-positions/source-position-index.js";
export {
    validateChunkMetadata,
    validateDocumentMetadata,
    validateFilterMetadata,
} from "./validation/records.js";
