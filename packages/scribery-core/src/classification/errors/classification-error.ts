export type ClassificationErrorCode =
    | "invalid-input"
    | "unsupported-encoding";

export interface ClassificationErrorContext {
    path: string;
    cause?: unknown;
}

export class ClassificationError extends Error {
    readonly code: ClassificationErrorCode;
    readonly path: string;
    override readonly cause: unknown;

    constructor(
        code: ClassificationErrorCode,
        message: string,
        context: ClassificationErrorContext,
    ) {
        super(message);
        this.name = "ClassificationError";
        this.code = code;
        this.path = context.path;
        this.cause = context.cause;
    }
}
