import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DeterministicFakeEmbeddingProvider } from "scribery-core";
import { DocumentationService } from "scribery-documents";

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
                    "list_documentations",
                    "list_projects",
                    "read_documentation_source",
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
            toolAllowlist: [
                "list_documentations",
                "search_documentation",
                "read_documentation_source",
            ],
        });
        const client = new Client({ name: "test-client", version: "test" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        try {
            const { tools } = await client.listTools();
            assert.deepEqual(
                tools.map(({ name }) => name),
                [
                    "list_documentations",
                    "read_documentation_source",
                    "search_documentation",
                ],
            );
            const [list, read, search] = tools;
            assert.equal(list?.title, "List documentation");
            assert.match(list?.description ?? "", /searched with search_documentation/u);
            assert.equal(read?.title, "Read a documentation source");
            assert.match(read?.description ?? "", /references another file/u);
            assert.deepEqual(
                read?.inputSchema.required,
                ["documentation", "source"],
            );
            const sourceProperty = read?.inputSchema.properties
                ?.source as { description?: string } | undefined;
            assert.match(
                sourceProperty?.description ?? "",
                /documentation-relative path/u,
            );
            assert.equal(search?.title, "Search documentation");
            assert.match(search?.description ?? "", /API references/u);
            assert.match(search?.description ?? "", /Call list_documentations first/u);
            assert.match(search?.description ?? "", /read_documentation_source/u);
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
                "Documentation name returned by list_documentations.",
            );
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("reads an active documentation source by path or source identifier", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-mcp-read-source-"));
        const sourceRoot = join(directory, "source", "guides");
        const documentationsDirectory = join(directory, "documentations");
        const sourcePath = join(sourceRoot, "authentication.md");
        const originalContent = "# Authentication\nUse signed session tokens.\n";
        await mkdir(sourceRoot, { recursive: true });
        await writeFile(sourcePath, originalContent, "utf8");

        const documentationService = new DocumentationService({
            embeddingProvider: new DeterministicFakeEmbeddingProvider(16),
            documentationsDirectory,
        });
        const documentation = await documentationService.createDocumentation(
            "Framework docs",
            "Authentication, routing, and deployment guides.",
        );
        await documentationService.addDirectorySource(documentation.documentationId, {
            root: sourceRoot,
            mountPath: "guides",
            include: ["**/*.md"],
        });
        await documentationService.indexDocumentation(documentation.documentationId);
        const [indexedSource] = await documentationService.listIndexedSources(
            documentation.documentationId,
        );
        assert.ok(indexedSource);

        await writeFile(sourcePath, "Changed after the active build.\n", "utf8");

        const server = createScriberyMcpServer({
            version: "test",
            documentationsDirectory,
            toolAllowlist: ["list_documentations", "read_documentation_source"],
        });
        const client = new Client({ name: "test-client", version: "test" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        try {
            const listed = await client.callTool({
                name: "list_documentations",
                arguments: {},
            });
            assert.deepEqual(listed.structuredContent, {
                documentations: [{
                    name: "Framework docs",
                    description: "Authentication, routing, and deployment guides.",
                }],
            });

            const byPath = await client.callTool({
                name: "read_documentation_source",
                arguments: {
                    documentation: "Framework docs",
                    source: "guides/authentication.md",
                },
            });
            assert.equal(byPath.isError, undefined, textContent(byPath.content));
            assert.equal(
                (byPath.structuredContent as Record<string, unknown>).content,
                originalContent,
            );

            const firstPage = await client.callTool({
                name: "read_documentation_source",
                arguments: {
                    documentation: documentation.documentationId,
                    source: indexedSource.sourceId,
                    maxCharacters: 12,
                },
            });
            const page = firstPage.structuredContent as Record<string, unknown>;
            assert.equal(page.path, "guides/authentication.md");
            assert.equal(page.content, originalContent.slice(0, 12));
            assert.equal(page.hasMore, true);
            assert.equal(page.nextStart, 12);
            assert.equal(page.totalCharacters, originalContent.length);
        } finally {
            await client.close();
            await server.close();
            await rm(directory, { recursive: true, force: true });
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
