import { ChunkingError } from "../errors/chunking-error.js";

export function throwIfChunkingAborted(
    signal: AbortSignal | undefined,
    path: string,
): void {
    if (signal?.aborted !== true) {
        return;
    }

    throw new ChunkingError(
        "cancelled",
        `Chunking was cancelled for ${path}`,
        { path },
        signal.reason,
    );
}
