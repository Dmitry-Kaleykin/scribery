export const MCP_DEFAULT_RESULT_LIMIT = 10;

// search_codebase returns fewer, more complete hits: one call should be enough
// to act on, so the caller does not need a second call to widen the context.
export const MCP_CODEBASE_RESULT_LIMIT = 6;

export const MCP_DEFAULT_CHUNK_PAGE_SIZE = 20;
export const MCP_MAXIMUM_CHUNK_PAGE_SIZE = 100;
export const MCP_DEFAULT_DOCUMENTATION_SOURCE_CHARACTERS = 20_000;
export const MCP_MAXIMUM_DOCUMENTATION_SOURCE_CHARACTERS = 100_000;

export const MCP_SERVER_NAME = "scribery";

export const READ_ONLY_TOOL_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;
