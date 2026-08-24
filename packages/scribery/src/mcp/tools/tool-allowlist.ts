import {
    MCP_TOOL_ALIASES,
    MCP_TOOL_NAMES,
    type McpToolName,
    type McpToolSelection,
} from "../constants/tools.js";

const MCP_TOOL_NAME_SET: ReadonlySet<string> = new Set(MCP_TOOL_NAMES);
const MCP_TOOL_ALIAS_SET: ReadonlySet<string> = new Set(
    Object.keys(MCP_TOOL_ALIASES),
);

export function parseMcpToolAllowlist(
    values: readonly string[] | undefined,
): readonly McpToolName[] | undefined {
    if (values === undefined) return undefined;

    const names = values.flatMap((value) => value.split(","))
        .map((value) => value.trim());

    if (names.length === 0 || names.some((name) => name.length === 0)) {
        throw new Error("--tools must contain at least one MCP tool name");
    }

    const unknown = names.filter((name) =>
        !MCP_TOOL_NAME_SET.has(name) && !MCP_TOOL_ALIAS_SET.has(name)
    );
    if (unknown.length > 0) {
        throw new Error(
            `Unknown MCP tool${unknown.length === 1 ? "" : "s"}: ` +
            `${[...new Set(unknown)].join(", ")}. Available tools: ` +
            MCP_TOOL_NAMES.join(", "),
        );
    }

    return [...new Set(names.map(resolveToolName))];
}

export function resolveMcpToolAllowlist(
    allowlist: readonly McpToolSelection[] | undefined,
): ReadonlySet<McpToolName> {
    const parsed = parseMcpToolAllowlist(allowlist);
    return new Set(parsed ?? MCP_TOOL_NAMES);
}

function resolveToolName(name: string): McpToolName {
    if (MCP_TOOL_NAME_SET.has(name)) return name as McpToolName;
    return MCP_TOOL_ALIASES[name as keyof typeof MCP_TOOL_ALIASES];
}
