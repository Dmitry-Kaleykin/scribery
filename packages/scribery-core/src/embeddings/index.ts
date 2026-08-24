export {
    DEFAULT_EMBEDDING_BATCH_CHARACTERS,
    DEFAULT_EMBEDDING_BATCH_INPUTS,
    EMBEDDING_FORMATTER_VERSION,
} from "./constants/defaults.js";
export {
    DEFAULT_LM_STUDIO_BASE_URL,
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
} from "../shared/index.js";
export type {
    EmbeddingProviderDiagnosticOptions,
    EmbeddingProviderDiagnosticResult,
} from "./contracts/diagnostic.js";
export type {
    DocumentEmbeddingContent,
    EmbeddingBatch,
    EmbeddingInput,
    EmbeddingMode,
    EmbeddingProvider,
    EmbeddingProviderOptions,
    EmbeddingProgress,
    EmbeddingResult,
    EmbeddingServiceOptions,
} from "./contracts/embedding.js";
export { EmbeddingService } from "./embedding-service.js";
export { diagnoseEmbeddingProvider } from "./diagnostics/provider.js";
export {
    EmbeddingError,
    type EmbeddingErrorCode,
} from "./errors/embedding-error.js";
export {
    formatDocumentEmbeddingInput,
    formatQueryEmbeddingInput,
} from "./formatting/format-input.js";
export { DeterministicFakeEmbeddingProvider } from "./providers/fake/fake-provider.js";
export {
    OpenAiCompatibleEmbeddingProvider,
    type OpenAiCompatibleEmbeddingProviderOptions,
    LmStudioEmbeddingProvider,
    type LmStudioEmbeddingProviderOptions,
} from "./providers/lm-studio/lm-studio-provider.js";
