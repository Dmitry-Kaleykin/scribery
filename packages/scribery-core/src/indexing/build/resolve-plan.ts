import {
    CHUNKING_IMPLEMENTATION_VERSION,
    DEFAULT_MAXIMUM_CHUNK_SIZE,
    DEFAULT_SLIDING_WINDOW_OVERLAP,
    SLIDING_WINDOW_IMPLEMENTATION_VERSION,
} from "../constants/build.js";
import type { IndexBuildPlan } from "../contracts/build-engine.js";
import { IndexingError } from "../errors/indexing-error.js";
import type {
    ResolvedIndexBuildPlan,
} from "./contracts/resolved-plan.js";

export function resolveIndexBuildPlan(
    plan: IndexBuildPlan,
): ResolvedIndexBuildPlan {
    const maximumChunkSize = plan.maximumChunkSize ??
        DEFAULT_MAXIMUM_CHUNK_SIZE;
    const slidingWindowOverlap = plan.slidingWindowOverlap ?? Math.min(
        DEFAULT_SLIDING_WINDOW_OVERLAP,
        Math.floor(maximumChunkSize / 5),
    );

    if (
        plan.policyIdentity.trim().length === 0 ||
        plan.strategies.length === 0 ||
        new Set(plan.strategies).size !== plan.strategies.length ||
        plan.strategies.some(
            (strategy) =>
                strategy !== "cast" &&
                strategy !== "sliding-window",
        ) ||
        !Number.isSafeInteger(maximumChunkSize) ||
        maximumChunkSize < 1 ||
        !Number.isSafeInteger(slidingWindowOverlap) ||
        slidingWindowOverlap < 0 ||
        slidingWindowOverlap >= maximumChunkSize ||
        (
            plan.maximumEmbeddingInputsPerBatch !== undefined &&
            (
                !Number.isSafeInteger(plan.maximumEmbeddingInputsPerBatch) ||
                plan.maximumEmbeddingInputsPerBatch < 1
            )
        )
    ) {
        throw new IndexingError(
            "invalid-configuration",
            "Index build plan is invalid",
        );
    }

    return {
        maximumChunkSize,
        slidingWindowOverlap,
        castChunkingIdentity:
            `${CHUNKING_IMPLEMENTATION_VERSION}:${maximumChunkSize}`,
        slidingChunkingIdentity:
            `${SLIDING_WINDOW_IMPLEMENTATION_VERSION}:${maximumChunkSize}:${slidingWindowOverlap}`,
    };
}

