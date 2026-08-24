export type EmbeddingErrorCode =
    | "cancelled"
    | "diagnostic-failed"
    | "duplicate-input"
    | "input-too-large"
    | "invalid-input"
    | "invalid-provider-response"
    | "provider-unavailable";

export class EmbeddingError extends Error {
    readonly code: EmbeddingErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: EmbeddingErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "EmbeddingError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
