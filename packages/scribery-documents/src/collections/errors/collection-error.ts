export type CollectionErrorCode =
    | "invalid-collection"
    | "collection-not-found"
    | "collection-exists"
    | "source-not-found"
    | "source-conflict"
    | "build-required"
    | "collection-storage-failure";

export class CollectionError extends Error {
    readonly code: CollectionErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause: unknown;

    constructor(
        code: CollectionErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "CollectionError";
        this.code = code;
        this.details = details;
        this.cause = cause;
    }
}
