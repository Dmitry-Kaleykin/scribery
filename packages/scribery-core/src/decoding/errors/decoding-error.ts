import type { SupportedEncoding } from "../../shared/contracts/encoding.js";

export type DecodingErrorCode =
    | "cancelled"
    | "invalid-options"
    | "io-error"
    | "malformed-input"
    | "maximum-byte-length-exceeded"
    | "unsupported-encoding";

export interface DecodingErrorContext {
    path: string;
    encoding?: SupportedEncoding;
    byteLength?: number;
    cause?: unknown;
}

export class DecodingError extends Error {
    readonly code: DecodingErrorCode;
    readonly path: string;
    readonly encoding: SupportedEncoding | undefined;
    readonly byteLength: number | undefined;
    override readonly cause: unknown;

    constructor(
        code: DecodingErrorCode,
        message: string,
        context: DecodingErrorContext,
    ) {
        super(message);
        this.name = "DecodingError";
        this.code = code;
        this.path = context.path;
        this.encoding = context.encoding;
        this.byteLength = context.byteLength;
        this.cause = context.cause;
    }
}
