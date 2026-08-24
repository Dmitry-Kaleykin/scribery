import type {
    ByteSource,
    ByteSourceReadOptions,
} from "../contracts/byte-source.js";

export class FakeByteSource implements ByteSource {
    readonly #chunks: readonly Uint8Array[];
    readonly #error: unknown;

    constructor(chunks: readonly Uint8Array[], error?: unknown) {
        this.#chunks = chunks;
        this.#error = error;
    }

    static fromBytes(
        bytes: Uint8Array,
        chunkSize = bytes.byteLength || 1,
    ): FakeByteSource {
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
            throw new RangeError("chunkSize must be a positive safe integer");
        }

        const chunks: Uint8Array[] = [];

        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            chunks.push(bytes.slice(offset, offset + chunkSize));
        }

        return new FakeByteSource(chunks);
    }

    async *read(options: ByteSourceReadOptions): AsyncIterable<Uint8Array> {
        for (const chunk of this.#chunks) {
            options.signal?.throwIfAborted();
            yield chunk.slice();
        }

        if (this.#error !== undefined) {
            throw this.#error;
        }
    }
}
