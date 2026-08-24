export type SourceErrorCode = "dirty-working-tree";

export class SourceError extends Error {
    readonly code: SourceErrorCode;
    readonly details: Readonly<Record<string, unknown>>;

    constructor(
        code: SourceErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
    ) {
        super(message);
        this.name = "SourceError";
        this.code = code;
        this.details = details;
    }
}

