export interface ByteSourceReadOptions {
    signal?: AbortSignal;
}

export interface ByteSource {
    read(options: ByteSourceReadOptions): AsyncIterable<Uint8Array>;
}
