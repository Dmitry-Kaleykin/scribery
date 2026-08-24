import type { ByteSource } from "../contracts/byte-source.js";
import { DecodingError } from "../errors/decoding-error.js";
import { throwIfAborted } from "./throw-if-aborted.js";

export async function collectBytes(
    path: string,
    source: ByteSource,
    maxByteLength: number,
    signal: AbortSignal | undefined,
): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;

    try {
        const readOptions = signal === undefined ? {} : { signal };

        for await (const chunk of source.read(readOptions)) {
            throwIfAborted(path, signal);

            if (!(chunk instanceof Uint8Array)) {
                throw new TypeError("ByteSource yielded a non-Uint8Array value");
            }

            byteLength += chunk.byteLength;

            if (byteLength > maxByteLength) {
                throw new DecodingError(
                    "maximum-byte-length-exceeded",
                    `File ${path} exceeds the ${maxByteLength}-byte decoding limit`,
                    { path, byteLength },
                );
            }

            if (chunk.byteLength > 0) {
                chunks.push(Uint8Array.from(chunk));
            }
        }
    } catch (error: unknown) {
        if (error instanceof DecodingError) {
            throw error;
        }

        throwIfAborted(path, signal);

        throw new DecodingError(
            "io-error",
            `Unable to read bytes for ${path}`,
            { path, byteLength, cause: error },
        );
    }

    throwIfAborted(path, signal);

    const bytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return bytes;
}
