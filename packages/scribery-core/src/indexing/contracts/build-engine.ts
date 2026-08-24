import type { IndexingPolicy, IndexingStrategy } from "./policy.js";
import type {
    EncodingPathRule,
    IndexingProgress,
    IndexingResult,
} from "./coordinator.js";
import type {
    PreparedSourceSnapshot,
} from "../../sources/contracts/source.js";
import type { Windows1251EncodingLabel } from "../../shared/index.js";

export interface IndexBuildPlan {
    policy: IndexingPolicy;
    policyIdentity: string;
    strategies: readonly IndexingStrategy[];
    maximumChunkSize?: number;
    slidingWindowOverlap?: number;
    maximumEmbeddingInputsPerBatch?: number;
    encodingFallback?: Windows1251EncodingLabel;
    encodingOverrides?: readonly EncodingPathRule[];
    onProgress?: (progress: IndexingProgress) => void;
    signal?: AbortSignal;
}

export interface IndexBuildRequest {
    source: PreparedSourceSnapshot;
    plan: IndexBuildPlan;
}

export type IndexBuildResult = IndexingResult;
