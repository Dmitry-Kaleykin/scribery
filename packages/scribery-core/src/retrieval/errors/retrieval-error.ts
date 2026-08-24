export type RetrievalErrorCode =
    | "build-not-ready"
    | "cancelled"
    | "invalid-request"
    | "reranking-failed"
    | "scope-mismatch";

export class RetrievalError extends Error {
    readonly code: RetrievalErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: RetrievalErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "RetrievalError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
