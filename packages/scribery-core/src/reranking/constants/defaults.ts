export const DEFAULT_RERANKING_BATCH_CANDIDATES = 16;
export const DEFAULT_RERANKING_BATCH_CHARACTERS = 128_000;
export const DEFAULT_RERANKING_CONCURRENT_REQUESTS = 4;
export const DEFAULT_RERANKING_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
export const MAXIMUM_RERANKING_ERROR_RESPONSE_CHARACTERS = 4_096;

export const QWEN3_RERANKING_FALSE_TOKEN_ID = 2_152;
export const QWEN3_RERANKING_TRUE_TOKEN_ID = 9_693;
export const QWEN3_RERANKING_LABEL_LOGIT_BIAS = 100;

export const QWEN3_CODE_RERANKING_INSTRUCTION =
    "Given a source-code search query, determine whether the code passage is relevant to finding or understanding the requested implementation.";
