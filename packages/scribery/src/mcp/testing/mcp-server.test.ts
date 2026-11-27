import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
    ProjectIndexingService,
    ProjectLiveIndexingStateCatalog,
    ProjectRetrievalTargetService,
    managedProjectDirectory,
} from "scribery-code";
import { ProviderProfileService } from "scribery-core";

import { createScriberyMcpServer, MCP_TOOL_NAMES } from "../index.js";
import type { ScriberyMcpServerOptions } from "../contracts/server.js";
import { McpProjectManagementService } from "../services/project-management-service.js";
import { resolveMcpApiKey, runScriberyMcpServer } from "../run.js";

describe("Scribery MCP server", () => {
    it("advertises four code tools with small schemas and accurate mutation hints", async (t) => {
        const directory = await temporaryDirectory(t);
        const client = await connect(t, { version: "test", indexesDirectory: directory });
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map(({ name }) => name), [...MCP_TOOL_NAMES]);
        assert.deepEqual([...MCP_TOOL_NAMES].sort(), ["index_codebase", "list_targets", "search_codebase", "switch_target"]);
        const search = tools.find(({ name }) => name === "search_codebase")!;
        assert.deepEqual(search.inputSchema.required, ["query"]);
        assert.deepEqual(Object.keys(search.inputSchema.properties ?? {}), ["query", "limit", "compress"]);
        assert.match(search.description!, /Recent edits may not yet be indexed/u);
        assert.equal(search.annotations?.readOnlyHint, true);
        assert.equal(tools.find(({ name }) => name === "list_targets")?.annotations?.readOnlyHint, true);
        const index = tools.find(({ name }) => name === "index_codebase")!;
        assert.deepEqual(Object.keys(index.inputSchema.properties ?? {}), ["target"]);
        assert.equal(index.annotations?.readOnlyHint, false);
        assert.equal(index.annotations?.destructiveHint, true);
        assert.equal(index.annotations?.idempotentHint, false);
        const selection = tools.find(({ name }) => name === "switch_target")!;
        assert.deepEqual(selection.inputSchema.required, ["target"]);
        assert.equal(selection.annotations?.readOnlyHint, false);
        assert.equal(selection.annotations?.destructiveHint, false);

        for (const name of ["search_codebase", "list_targets", "index_codebase", "switch_target"]) {
            const result = await client.callTool({ name, arguments: name === "search_codebase" ? { query: "authentication" } : name === "switch_target" ? { target: "main" } : {} });
            assert.equal(result.isError, true);
            assert.match(textContent(result.content), /No indexed projects are available/u);
        }
    });

    it("rejects the removed --tools option", async () => {
        await assert.rejects(runScriberyMcpServer(["--tools", "search_codebase"], "test"), /Unknown option.*tools/u);
    });

    it("creates the branch target, searches it, and switches existing targets without rebuilding", async (t) => {
        const fixture = await projectFixture(t);
        git(fixture.root, "switch", "-c", "task/fix-upload");
        await writeFile(join(fixture.root, "example.ts"), "export const uploadLimit = 42;\n");
        await writeFile(join(fixture.root, "ignored.ts"), "export const ignored = true;\n");
        const recipePath = join(managedProjectDirectory(fixture.projectIdentifier, fixture.options.indexesDirectory), "indexing-recipe.json");
        const recipeBefore = await readFile(recipePath, "utf8");
        const client = await connect(t, fixture.options);
        const progress: string[] = [];
        const indexed = await client.callTool({ name: "index_codebase", arguments: {} }, undefined, {
            onprogress: (value) => { progress.push(value.message ?? ""); },
        });
        assert.equal(indexed.isError, undefined, textContent(indexed.content));
        const summary = structured(indexed);
        assert.equal(summary.status, "ready");
        assert.equal(summary.files, 1, "saved excludes must apply");
        const active = summary.active as { target: string; indexBuildId: string };
        assert.equal(active.target, "task/fix-upload");
        assert.notEqual(active.indexBuildId, fixture.initialBuild);
        assert.ok(progress.length > 0);
        assert.equal(await readFile(recipePath, "utf8"), recipeBefore, "MCP indexing must preserve manual recipe settings");

        const searched = await client.callTool({ name: "search_codebase", arguments: { query: "upload limit", compress: false } });
        assert.equal(searched.isError, undefined, textContent(searched.content));
        assert.equal(structured(searched).indexBuildId, active.indexBuildId);
        assert.match(textContent(searched.content), /uploadLimit = 42/u);

        const switched = await client.callTool({ name: "switch_target", arguments: { target: "release" } });
        assert.deepEqual(structured(switched).active, { type: "target", target: "release", indexBuildId: fixture.initialBuild });
        const oldSearch = await client.callTool({ name: "search_codebase", arguments: { query: "version", compress: false } });
        assert.equal(structured(oldSearch).indexBuildId, fixture.initialBuild);
        assert.match(textContent(oldSearch.content), /version = 1/u);
        const listing = await client.callTool({ name: "list_targets", arguments: {} });
        assert.deepEqual(listing.structuredContent, {
            active: structured(switched).active,
            targets: [
                { name: "release", indexBuildId: fixture.initialBuild },
                { name: "task/fix-upload", indexBuildId: active.indexBuildId },
            ],
        });
        const missing = await client.callTool({ name: "switch_target", arguments: { target: "missing" } });
        assert.equal(missing.isError, true);
        assert.match(textContent(missing.content), /was not found/u);
        assert.equal(((await fixture.targets.status(fixture.root)).active as { target: string }).target, "release");
    });

    it("updates an explicit target independent of the branch and applies saved retention", async (t) => {
        const fixture = await projectFixture(t, { keepReplacedBuilds: 0 });
        const client = await connect(t, fixture.options);
        await writeFile(join(fixture.root, "example.ts"), "export const version = 2;\n");
        const result = await client.callTool({ name: "index_codebase", arguments: { target: "release" } });
        assert.equal(result.isError, undefined, textContent(result.content));
        assert.equal((structured(result).active as { target: string }).target, "release");
        assert.equal(git(fixture.root, "branch", "--show-current"), "main");
        const project = await fixture.targets.resolveProject(fixture.root);
        assert.equal(project.buildCount, 1, "saved zero-retention must remove the replaced build");
    });

    it("requires an explicit target in detached HEAD and accepts one", async (t) => {
        const fixture = await projectFixture(t);
        git(fixture.root, "checkout", "--detach");
        const client = await connect(t, fixture.options);
        const implicit = await client.callTool({ name: "index_codebase", arguments: {} });
        assert.equal(implicit.isError, true);
        assert.match(textContent(implicit.content), /explicit target/u);
        const explicit = await client.callTool({ name: "index_codebase", arguments: { target: "snapshot/custom" } });
        assert.equal(explicit.isError, undefined, textContent(explicit.content));
        assert.equal((structured(explicit).active as { target: string }).target, "snapshot/custom");
    });

    it("requires an explicit target for a plain directory", async (t) => {
        const fixture = await projectFixture(t, { git: false });
        const service = new McpProjectManagementService(fixture.options);
        await assert.rejects(service.indexCodebase(), /explicit target/u);
        assert.equal((await service.indexCodebase("plain") as { status: string }).status, "ready");
    });

    it("requires saved settings and validates destinations before calling the provider", async (t) => {
        const fixture = await projectFixture(t);
        const service = new McpProjectManagementService(fixture.options);
        let requested = false;
        fixture.provider.beforeRequest = async () => { requested = true; };
        await assert.rejects(service.indexCodebase("live/current"), /reserved/u);
        await assert.rejects(service.indexCodebase("bad..name"), /Retrieval target/u);
        assert.equal(requested, false);
        await rm(join(managedProjectDirectory(fixture.projectIdentifier, fixture.options.indexesDirectory), "indexing-recipe.json"));
        await assert.rejects(service.indexCodebase(), /no saved indexing settings[\s\S]*CLI\/TUI/u);
        assert.equal(requested, false);
    });

    it("preserves the previous target on provider failure and permits a retry", async (t) => {
        const fixture = await projectFixture(t);
        const client = await connect(t, fixture.options);
        const previous = (await fixture.targets.status(fixture.root)).active;
        fixture.provider.beforeRequest = async () => { throw new Error("provider offline"); };
        const failed = await client.callTool({ name: "index_codebase", arguments: { target: "task/failure" } });
        assert.equal(failed.isError, true);
        assert.match(textContent(failed.content), /diagnostic failed|provider offline/u);
        assert.deepEqual((await fixture.targets.status(fixture.root)).active, previous);
        fixture.provider.beforeRequest = undefined;
        const retried = await client.callTool({ name: "index_codebase", arguments: { target: "task/failure" } });
        assert.equal(retried.isError, undefined, textContent(retried.content));
    });

    it("rejects competing mutations and does not publish after cancellation", async (t) => {
        const fixture = await projectFixture(t);
        const service = new McpProjectManagementService(fixture.options);
        const second = new McpProjectManagementService(fixture.options);
        const controller = new AbortController();
        const entered = Promise.withResolvers<void>();
        fixture.provider.beforeRequest = async (signal) => {
            entered.resolve();
            await new Promise<void>((_resolve, reject) => {
                signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
            });
        };
        const indexing = service.indexCodebase("task/cancelled", controller.signal);
        const rejected = assert.rejects(indexing);
        await entered.promise;
        await assert.rejects(second.switchTarget("release"), /already running/u);
        controller.abort();
        await rejected;
        assert.equal(((await fixture.targets.status(fixture.root)).active as { target: string }).target, "release");
        fixture.provider.beforeRequest = undefined;
        await second.switchTarget("release");
    });

    it("does not publish a branch target if Git HEAD changes during indexing", async (t) => {
        const fixture = await projectFixture(t);
        git(fixture.root, "switch", "-c", "task/original");
        fixture.provider.beforeRequest = async () => {
            fixture.provider.beforeRequest = undefined;
            git(fixture.root, "switch", "-c", "task/changed");
        };
        const service = new McpProjectManagementService(fixture.options);
        await assert.rejects(service.indexCodebase(), /branch or HEAD changed/u);
        const listing = await service.listTargets();
        assert.deepEqual((listing.targets as { name: string }[]).map(({ name }) => name), ["release"]);
        assert.equal((listing.active as { target: string }).target, "release");
    });

    it("keeps the implicit previous build selected if cancelled after a new build is ready", async (t) => {
        const fixture = await projectFixture(t, { withoutTarget: true });
        await writeFile(join(fixture.root, "example.ts"), "export const version = 2;\n");
        const controller = new AbortController();
        const service = new McpProjectManagementService(fixture.options);
        await assert.rejects(service.indexCodebase("task/unpublished", controller.signal, (event) => {
            if (event.type === "operation-complete") controller.abort();
        }));
        const status = await fixture.targets.status(fixture.root);
        assert.deepEqual(status.active, { type: "build", indexBuildId: fixture.initialBuild });
        assert.deepEqual((await service.listTargets()).targets, []);
        assert.equal((await fixture.targets.resolveProject(fixture.root)).buildsByStatus.ready, 2);
    });

    it("does not interfere with a running live indexing session", async (t) => {
        const fixture = await projectFixture(t);
        const now = new Date().toISOString();
        const states = new ProjectLiveIndexingStateCatalog(fixture.options.indexesDirectory);
        await states.write({
            schemaVersion: 1, projectIdentifier: fixture.projectIdentifier,
            sessionId: "test-session", processId: process.pid, root: fixture.root,
            phase: "indexing", generation: 1, startedAt: now, updatedAt: now,
        });
        const client = await connect(t, fixture.options);
        for (const name of ["index_codebase", "switch_target"]) {
            const result = await client.callTool({ name, arguments: { target: "release" } });
            assert.equal(result.isError, true);
            assert.match(textContent(result.content), /Stop live indexing/u);
        }
        const search = await client.callTool({ name: "search_codebase", arguments: { query: "version" } });
        assert.equal(search.isError, true);
        assert.match(textContent(search.content), /retrieval is paused/u);
    });

    it("resolves an explicit API key before environment fallbacks", () => {
        const environment = { OPENAI_COMPATIBLE_API_KEY: "environment-key", LM_STUDIO_API_KEY: "legacy-key" };
        assert.equal(resolveMcpApiKey(" explicit-key ", environment), "explicit-key");
        assert.equal(resolveMcpApiKey(undefined, environment), "environment-key");
        assert.equal(resolveMcpApiKey(undefined, { LM_STUDIO_API_KEY: "legacy-key" }), "legacy-key");
        assert.equal(resolveMcpApiKey(undefined, {}), undefined);
        assert.throws(() => resolveMcpApiKey("  ", environment), /--api-key must not be empty/u);
    });
});

async function temporaryDirectory(t: TestContext): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "scribery-mcp-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

async function connect(t: TestContext, options: ScriberyMcpServerOptions): Promise<Client> {
    const server = createScriberyMcpServer(options);
    const client = new Client({ name: "test-client", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
}

async function projectFixture(t: TestContext, settings: { git?: boolean; keepReplacedBuilds?: number; withoutTarget?: boolean } = {}) {
    const directory = await temporaryDirectory(t);
    const root = join(directory, "project");
    const indexesDirectory = join(directory, "indexes");
    const profilesPath = join(directory, "profiles.json");
    await mkdir(root);
    await writeFile(join(root, "example.ts"), "export const version = 1;\n");
    if (settings.git !== false) {
        git(root, "init", "-b", "main");
        git(root, "add", ".");
        git(root, "-c", "user.name=MCP Test", "-c", "user.email=mcp@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Initial");
    }
    const provider: { beforeRequest: ((signal: AbortSignal | null | undefined) => Promise<void>) | undefined } = { beforeRequest: undefined };
    const fetch: typeof globalThis.fetch = async (input, init) => {
        assert.equal(String(input), "http://fixture.invalid/v1/embeddings");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
        await provider.beforeRequest?.(init?.signal);
        const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
        assert.equal(body.model, "fixture-embedding");
        return Response.json({ data: body.input.map((_value, index) => ({ index, embedding: [1, 0, 0] })) });
    };
    const options: ScriberyMcpServerOptions = {
        version: "test", defaultProjectReference: root, indexesDirectory,
        profilesPath, fetch, apiKey: "test-key", baseUrl: "http://fixture.invalid/v1",
    };
    await new ProviderProfileService({ profilesPath }).set({
        name: "fixture", embedding: {
            provider: "openai-compatible", model: "fixture-embedding", dimensions: 3,
            baseUrl: "http://fixture.invalid/v1", maximumInputs: 4,
        },
    });
    const first = await new ProjectIndexingService(options).index({
        root, provider: { type: "profile", profile: "fixture" },
        ...(settings.withoutTarget ? {} : { target: "release" }),
        keepReplacedBuilds: settings.keepReplacedBuilds ?? 1, allowDirty: true,
        exclude: ["ignored.ts"], maximumChunkSize: 500,
    });
    return {
        root, options, provider, initialBuild: first.result.indexBuildId,
        projectIdentifier: first.project!.projectIdentifier,
        targets: new ProjectRetrievalTargetService({ indexesDirectory }),
    };
}

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function textContent(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content.filter((item): item is { type: "text"; text: string } =>
        typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string"
    ).map(({ text }) => text).join("\n");
}

function structured(result: Record<string, unknown>): Record<string, unknown> {
    assert.ok(result.structuredContent);
    return result.structuredContent as Record<string, unknown>;
}
