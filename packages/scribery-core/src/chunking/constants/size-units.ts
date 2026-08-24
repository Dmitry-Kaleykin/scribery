import type { ChunkSizeUnit } from "../contracts/chunk.js";

export const CHUNK_SIZE_UNIT = {
    UTF_16_CODE_UNITS: "utf16-code-units",
} as const satisfies Record<string, ChunkSizeUnit>;
