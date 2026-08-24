export type StorageErrorCode =
    | "build-not-found"
    | "duplicate-record"
    | "incompatible-model"
    | "invalid-record"
    | "invalid-vector"
    | "storage-failure";

export class StorageError extends Error {
    readonly code: StorageErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: StorageErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "StorageError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
