export type IndexingErrorCode =
    | "build-exists"
    | "cancelled"
    | "dirty-working-tree"
    | "indexing-failed"
    | "invalid-configuration";

export class IndexingError extends Error {
    readonly code: IndexingErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: IndexingErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "IndexingError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
