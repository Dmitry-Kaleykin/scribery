import type {
    FileClassification,
    FileTrait,
} from "../../classification/index.js";
import type { ChunkingStrategyId } from "../../shared/index.js";

export type IndexingAction = "index" | "skip" | "reject";
export type IndexingStrategy = ChunkingStrategyId;
export type OversizedFileAction = "skip" | "reject";

export type IndexingDecisionReason =
    | "binary-content"
    | "unknown-content"
    | "empty-file"
    | "plain-text"
    | "excluded-trait"
    | "file-too-large"
    | "cast-parser-unavailable";

export interface IndexingPolicyCapabilities {
    canChunkWithCast: boolean;
}

export interface IndexingPolicyInput {
    path: string;
    byteLength: number;
    classification: FileClassification;
    capabilities: IndexingPolicyCapabilities;
}

export interface CodeOnlyIndexingPolicyOptions {
    maxByteLength?: number;
    excludedTraits?: readonly FileTrait[];
    oversizedFileAction?: OversizedFileAction;
}

export type IndexingDecision =
    | {
        action: "index";
        strategy: IndexingStrategy;
    }
    | {
        action: "skip";
        reason:
            | "binary-content"
            | "unknown-content"
            | "empty-file"
            | "plain-text"
            | "cast-parser-unavailable";
    }
    | {
        action: "skip";
        reason: "excluded-trait";
        trait: FileTrait;
    }
    | {
        action: OversizedFileAction;
        reason: "file-too-large";
        byteLength: number;
        maxByteLength: number;
    };

export interface IndexingPolicy {
    evaluate(input: IndexingPolicyInput): IndexingDecision;
}
