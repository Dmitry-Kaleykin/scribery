import type { SlashCommand } from "@earendil-works/pi-tui";

export const COMMANDS: readonly SlashCommand[] = [
    { name: "index", description: "Create an up-to-date index for the active project" },
    { name: "project", description: "Switch or inspect an indexed project" },
    { name: "search", description: "Search with a guided query prompt" },
    { name: "profile", description: "Select, create, test, or remove provider profiles" },
    { name: "preset", description: "Select, create, inspect, or remove indexing presets" },
    { name: "builds", description: "Browse immutable build history" },
    { name: "target", description: "Inspect or switch retrieval targets" },
    { name: "chunks", description: "Inspect stored chunks for an indexed file", argumentHint: "<path>" },
    { name: "collection", description: "Browse and search managed document collections" },
    { name: "jobs", description: "Show the active indexing operation" },
    { name: "mcp", description: "Print MCP configuration for the active project" },
    { name: "doctor", description: "Test the selected model provider" },
    { name: "settings", description: "Show terminal interaction settings" },
    { name: "help", description: "Show commands and keyboard shortcuts" },
    { name: "clear", description: "Clear the visible transcript" },
    { name: "quit", description: "Exit Scribery" },
];

export function commandHelp(): string {
    const longest = Math.max(...COMMANDS.map(({ name }) => name.length));
    return [
        "Commands",
        "",
        ...COMMANDS.map(({ name, description }) =>
            `  /${name.padEnd(longest)}  ${description ?? ""}`
        ),
        "",
        "Type a question without / to search the active project.",
        "↑↓ navigate · Enter select · Tab complete · Esc back",
    ].join("\n");
}
