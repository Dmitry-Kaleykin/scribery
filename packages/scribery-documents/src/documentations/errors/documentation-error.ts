export type DocumentationErrorCode =
    | "invalid-documentation"
    | "documentation-not-found"
    | "documentation-exists"
    | "source-not-found"
    | "source-conflict"
    | "build-required"
    | "documentation-storage-failure";

export class DocumentationError extends Error {
    readonly code: DocumentationErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause: unknown;

    constructor(
        code: DocumentationErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "DocumentationError";
        this.code = code;
        this.details = details;
        this.cause = cause;
    }
}
