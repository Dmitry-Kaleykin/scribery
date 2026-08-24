import type { ChunkingStrategyId } from "../contracts/chunking.js";

export const CHUNKING_STRATEGY = {
    CAST: "cast",
    SLIDING_WINDOW: "sliding-window",
} as const satisfies Record<string, ChunkingStrategyId>;
