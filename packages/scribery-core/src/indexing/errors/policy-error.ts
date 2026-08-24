export type IndexingPolicyErrorCode = "invalid-input" | "invalid-options";

export interface IndexingPolicyErrorContext {
    path?: string;
    cause?: unknown;
}

export class IndexingPolicyError extends Error {
    readonly code: IndexingPolicyErrorCode;
    readonly path: string | undefined;
    override readonly cause: unknown;

    constructor(
        code: IndexingPolicyErrorCode,
        message: string,
        context: IndexingPolicyErrorContext = {},
    ) {
        super(message);
        this.name = "IndexingPolicyError";
        this.code = code;
        this.path = context.path;
        this.cause = context.cause;
    }
}
