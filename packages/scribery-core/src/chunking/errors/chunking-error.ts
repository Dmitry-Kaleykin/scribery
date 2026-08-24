export type ChunkingErrorCode =
    | "cancelled"
    | "duplicate-parser"
    | "duplicate-parser-target"
    | "invalid-byte-offset"
    | "invalid-byte-boundary"
    | "invalid-document"
    | "invalid-chunks"
    | "invalid-options"
    | "invalid-parser"
    | "invalid-syntax-tree"
    | "parser-failure"
    | "unsupported-parser";

export class ChunkingError extends Error {
    readonly code: ChunkingErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: ChunkingErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "ChunkingError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
