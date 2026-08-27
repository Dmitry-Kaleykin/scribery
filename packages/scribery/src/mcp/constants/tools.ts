export const MCP_TOOL_NAMES = [
    "list_projects",
    "search_codebase",
    "inspect_project_chunks",
    "list_documentations",
    "list_documentation_sources",
    "search_documentation",
] as const;

export type McpToolName = typeof MCP_TOOL_NAMES[number];

export const MCP_TOOL_ALIASES = {
    retrieval: "search_codebase",
} as const satisfies Readonly<Record<string, McpToolName>>;

export type McpToolAlias = keyof typeof MCP_TOOL_ALIASES;
export type McpToolSelection = McpToolName | McpToolAlias;
