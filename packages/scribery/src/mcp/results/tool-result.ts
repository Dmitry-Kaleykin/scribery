import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { serializeError } from "scribery-core";

export function mcpToolSuccess<T extends object>(
    value: T,
    text = JSON.stringify(value, null, 2),
): CallToolResult {
    return {
        content: [{ type: "text", text }],
        structuredContent: Object.fromEntries(Object.entries(value)),
    };
}

export function mcpToolFailure(error: unknown): CallToolResult {
    const serialized = serializeError(error);
    const value = {
        error: serialized.code ?? "mcp-tool-failed",
        message: serialized.message,
        ...(serialized.details === undefined
            ? {}
            : { details: serialized.details }),
        ...(serialized.cause === undefined ? {} : { cause: serialized.cause }),
    };

    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        isError: true,
    };
}
