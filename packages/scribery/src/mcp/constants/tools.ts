export const MCP_TOOL_NAMES = [
    "search_codebase",
    "list_targets",
    "switch_target",
    "index_codebase",
] as const;

export type McpToolName = typeof MCP_TOOL_NAMES[number];
