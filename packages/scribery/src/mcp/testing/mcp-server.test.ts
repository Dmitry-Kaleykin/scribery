import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
    createScriberyMcpServer,
    parseMcpToolAllowlist,
} from "../index.js";
import { resolveMcpApiKey } from "../run.js";

describe("Scribery MCP server", () => {
    it("advertises only read-only search and inspection tools", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-mcp-"));
        const server = createScriberyMcpServer({
            version: "test",
            indexesDirectory: join(directory, "indexes"),
            documentationsDirectory: join(directory, "documentations"),
        });
        const client = new Client({ name: "test-client", version: "test" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        try {
            const { tools } = await client.listTools();
            assert.deepEqual(
                tools.map(({ name }) => name).sort(),
                [
                    "inspect_project_chunks",
                    "list_documentation_sources",
                    "list_documentations",
                    "list_projects",
                    "search_codebase",
                    "search_documentation",
                ],
            );
            assert.ok(tools.every(({ annotations }) =>
                annotations?.readOnlyHint === true &&
                annotations.destructiveHint === false &&
                annotations.idempotentHint === true
            ));
            assert.doesNotMatch(JSON.stringify(tools), /\bindexed\b/iu);

            const projects = await client.callTool({
                name: "list_projects",
                arguments: {},
            });
            assert.deepEqual(projects.structuredContent, {
                count: 0,
                projects: [],
            });

            const documentations = await client.callTool({
                name: "list_documentations",
                arguments: {},
            });
            assert.deepEqual(documentations.structuredContent, {
                count: 0,
                documentations: [],
            });

            const failedSearch = await client.callTool({
                name: "search_codebase",
                arguments: { query: "where is the API?" },
            });
            assert.equal(failedSearch.isError, true);
            assert.match(
                textContent(failedSearch.content),
                /No indexed projects are available/u,
            );
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("advertises only explicitly allowlisted tools", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-mcp-tools-"));
        const server = createScriberyMcpServer({
            version: "test",
            indexesDirectory: join(directory, "indexes"),
            documentationsDirectory: join(directory, "documentations"),
            toolAllowlist: ["search_codebase"],
        });
        const client = new Client({ name: "test-client", version: "test" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        try {
            const { tools } = await client.listTools();
            assert.deepEqual(tools.map(({ name }) => name), ["search_codebase"]);
            const [search] = tools;
            assert.equal(search?.title, "Search the codebase");
            assert.match(search?.description ?? "", /Use this first/u);
            assert.doesNotMatch(search?.description ?? "", /indexed|exact text/iu);
            assert.deepEqual(search?.inputSchema.required, ["query"]);
            assert.deepEqual(
                Object.keys(search?.inputSchema.properties ?? {}),
                ["query", "limit"],
            );
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("presents documentation retrieval as an explicit agent workflow", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-mcp-documentation-"));
        const server = createScriberyMcpServer({
            version: "test",
            indexesDirectory: join(directory, "indexes"),
            documentationsDirectory: join(directory, "documentations"),
            toolAllowlist: ["list_documentations", "search_documentation"],
        });
        const client = new Client({ name: "test-client", version: "test" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        try {
            const { tools } = await client.listTools();
            assert.deepEqual(
                tools.map(({ name }) => name),
                ["list_documentations", "search_documentation"],
            );
            const [list, search] = tools;
            assert.equal(list?.title, "List documentation");
            assert.match(list?.description ?? "", /searched with search_documentation/u);
            assert.equal(search?.title, "Search documentation");
            assert.match(search?.description ?? "", /API references/u);
            assert.match(search?.description ?? "", /Call list_documentations first/u);
            assert.doesNotMatch(
                search?.description ?? "",
                /indexed|default documentation|only one documentation|current project/iu,
            );
            assert.deepEqual(
                search?.inputSchema.required,
                ["query", "documentation"],
            );
            const documentationProperty = search?.inputSchema.properties
                ?.documentation as { description?: string } | undefined;
            assert.equal(
                documentationProperty?.description,
                "Documentation name or identifier returned by list_documentations.",
            );
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("parses comma-separated and repeated tool allowlists strictly", () => {
        assert.deepEqual(
            parseMcpToolAllowlist([
                "search_codebase, inspect_project_chunks",
                "search_codebase",
            ]),
            ["search_codebase", "inspect_project_chunks"],
        );
        assert.deepEqual(
            parseMcpToolAllowlist(["retrieval,search_codebase"]),
            ["search_codebase"],
        );
        assert.throws(
            () => parseMcpToolAllowlist(["retrieval,unknown_tool"]),
            /Unknown MCP tool: unknown_tool/u,
        );
        assert.throws(
            () => parseMcpToolAllowlist(["retrieval,"]),
            /must contain at least one MCP tool name/u,
        );
    });

    it("resolves an explicit MCP API key before environment fallbacks", () => {
        const environment = {
            OPENAI_COMPATIBLE_API_KEY: "environment-key",
            LM_STUDIO_API_KEY: "legacy-key",
        };

        assert.equal(
            resolveMcpApiKey(" explicit-key ", environment),
            "explicit-key",
        );
        assert.equal(resolveMcpApiKey(undefined, environment), "environment-key");
        assert.equal(
            resolveMcpApiKey(undefined, { LM_STUDIO_API_KEY: "legacy-key" }),
            "legacy-key",
        );
        assert.equal(resolveMcpApiKey(undefined, {}), undefined);
        assert.throws(
            () => resolveMcpApiKey("  ", environment),
            /--api-key must not be empty/u,
        );
    });
});

function textContent(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((item): item is { type: "text"; text: string } =>
            typeof item === "object" && item !== null &&
            "type" in item && item.type === "text" &&
            "text" in item && typeof item.text === "string"
        )
        .map(({ text }) => text)
        .join("\n");
}
