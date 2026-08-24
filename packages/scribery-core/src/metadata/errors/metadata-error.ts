export type MetadataErrorCode =
    | "invalid-hash"
    | "invalid-identity"
    | "invalid-metadata"
    | "invalid-path"
    | "unsupported-schema";

export class MetadataError extends Error {
    readonly code: MetadataErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: MetadataErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "MetadataError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
