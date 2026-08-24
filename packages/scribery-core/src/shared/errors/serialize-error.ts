export interface SerializedError {
    name: string;
    message: string;
    code?: string;
    details?: Readonly<Record<string, unknown>>;
    cause?: SerializedError;
}

export function serializeError(error: unknown, depth = 0): SerializedError {
    if (!(error instanceof Error)) {
        return { name: "Error", message: String(error) };
    }

    const withMetadata = error as Error & {
        code?: unknown;
        details?: unknown;
        cause?: unknown;
    };
    const details = isRecord(withMetadata.details)
        ? withMetadata.details
        : undefined;
    const cause = depth >= 5 || withMetadata.cause === undefined
        ? undefined
        : serializeError(withMetadata.cause, depth + 1);

    return {
        name: error.name,
        message: error.message,
        ...(withMetadata.code === undefined
            ? {}
            : { code: String(withMetadata.code) }),
        ...(details === undefined ? {} : { details }),
        ...(cause === undefined ? {} : { cause }),
    };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
