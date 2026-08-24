export {
    DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH,
} from "./constants/defaults.js";
export {
    INDEXING_ACTION,
    INDEXING_DECISION_REASON,
    INDEXING_STRATEGY,
    OVERSIZED_FILE_ACTION,
} from "./constants/decisions.js";
export type {
    EncodingPathRule,
    IndexingConfiguration,
    IndexingCoordinatorOptions,
    IndexingDiagnostic,
    IndexingProgress,
    IndexingProgressActivity,
    IndexingProgressPhase,
    IndexingResult,
} from "./contracts/coordinator.js";
export type {
    IndexBuildPlan,
    IndexBuildRequest,
    IndexBuildResult,
} from "./contracts/build-engine.js";
export type {
    DocumentParserRegistry,
    DocumentProcessingRuntime,
    DocumentProcessingRuntimeOptions,
} from "./contracts/document-processing-runtime.js";
export type { PendingChunkEmbedding } from "./contracts/pending-chunk.js";
export { selectSearchableChunks } from "./chunks/select-searchable-chunks.js";
export {
    persistChunkEmbeddings,
    type PersistChunkEmbeddingsOptions,
    type PersistChunkEmbeddingsResult,
} from "./embeddings/persist-chunk-embeddings.js";
export type {
    CodeOnlyIndexingPolicyOptions,
    IndexingAction,
    IndexingDecision,
    IndexingDecisionReason,
    IndexingPolicy,
    IndexingPolicyCapabilities,
    IndexingPolicyInput,
    IndexingStrategy,
    OversizedFileAction,
} from "./contracts/policy.js";
export { IndexBuildEngine } from "./build-engine.js";
export {
    IndexingError,
    type IndexingErrorCode,
} from "./errors/indexing-error.js";
export {
    IndexingPolicyError,
    type IndexingPolicyErrorCode,
} from "./errors/policy-error.js";
export {
    APPLICATION_VERSION,
    ARTIFACT_COMPATIBILITY_VERSION,
    CHUNKING_IMPLEMENTATION_VERSION,
    DEFAULT_SLIDING_WINDOW_OVERLAP,
    DEFAULT_CLASSIFICATION_SAMPLE_BYTES,
    DEFAULT_MAXIMUM_CHUNK_SIZE,
    SLIDING_WINDOW_IMPLEMENTATION_VERSION,
} from "./constants/build.js";
export {
    createArtifactCompatibilityHash,
    type ArtifactCompatibilityIdentityInput,
} from "./identities/artifact-compatibility.js";
