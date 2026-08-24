import type {
    IndexingAction,
    IndexingDecisionReason,
    OversizedFileAction,
} from "../contracts/policy.js";
import { CHUNKING_STRATEGY } from "../../shared/index.js";

export const INDEXING_ACTION = {
    INDEX: "index",
    SKIP: "skip",
    REJECT: "reject",
} as const satisfies Record<string, IndexingAction>;

export const INDEXING_DECISION_REASON = {
    BINARY_CONTENT: "binary-content",
    UNKNOWN_CONTENT: "unknown-content",
    EMPTY_FILE: "empty-file",
    PLAIN_TEXT: "plain-text",
    EXCLUDED_TRAIT: "excluded-trait",
    FILE_TOO_LARGE: "file-too-large",
    CAST_PARSER_UNAVAILABLE: "cast-parser-unavailable",
} as const satisfies Record<string, IndexingDecisionReason>;

export const INDEXING_STRATEGY = CHUNKING_STRATEGY;

export const OVERSIZED_FILE_ACTION = {
    SKIP: "skip",
    REJECT: "reject",
} as const satisfies Record<string, OversizedFileAction>;
