export const MCP_DEFAULT_RESULT_LIMIT = 10;

// search_codebase returns fewer, more complete hits: one call should be enough
// to act on, so the caller does not need a second call to widen the context.
export const MCP_CODEBASE_RESULT_LIMIT = 6;

export const MCP_SERVER_NAME = "scribery";

export const READ_ONLY_TOOL_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;
