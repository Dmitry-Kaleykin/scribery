export type DiscoveryErrorCode = "cancelled" | "invalid-options" | "invalid-root";

export class DiscoveryError extends Error {
    readonly code: DiscoveryErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: DiscoveryErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = "DiscoveryError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}
