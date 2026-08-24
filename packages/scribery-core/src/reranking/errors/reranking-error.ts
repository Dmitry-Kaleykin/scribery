export type RerankingErrorCode =
    | "cancelled"
    | "duplicate-candidate"
    | "input-too-large"
    | "invalid-input"
    | "invalid-provider-response"
    | "provider-unavailable";

export class RerankingError extends Error {
    readonly code: RerankingErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: RerankingErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "RerankingError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
