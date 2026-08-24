import { DecodingError } from "../errors/decoding-error.js";

export function throwIfAborted(
    path: string,
    signal: AbortSignal | undefined,
): void {
    if (signal?.aborted !== true) {
        return;
    }

    throw new DecodingError("cancelled", `Decoding was cancelled for ${path}`, {
        path,
        cause: signal.reason,
    });
}
