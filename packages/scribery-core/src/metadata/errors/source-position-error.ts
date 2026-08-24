export type SourcePositionErrorCode =
    | "invalid-content"
    | "invalid-offset"
    | "out-of-bounds"
    | "empty-range"
    | "reversed-range"
    | "split-surrogate-pair"
    | "invalid-line-number"
    | "line-number-mismatch";

export class SourcePositionError extends Error {
    readonly code: SourcePositionErrorCode;
    readonly details: Readonly<Record<string, unknown>>;

    constructor(
        code: SourcePositionErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
    ) {
        super(message);
        this.name = "SourcePositionError";
        this.code = code;
        this.details = Object.freeze({ ...details });
    }
}
