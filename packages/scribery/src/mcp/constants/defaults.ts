export const MCP_DEFAULT_RESULT_LIMIT = 10;
export const MCP_DEFAULT_CHUNK_PAGE_SIZE = 20;
export const MCP_MAXIMUM_CHUNK_PAGE_SIZE = 100;

export const MCP_SERVER_NAME = "scribery";

export const READ_ONLY_TOOL_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;
