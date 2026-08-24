export type SourceControlErrorCode =
    | "cancelled"
    | "git-unavailable"
    | "invalid-root"
    | "ref-not-found"
    | "timeout"
    | "unexpected-git-error";

export class SourceControlError extends Error {
    readonly code: SourceControlErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: SourceControlErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "SourceControlError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
