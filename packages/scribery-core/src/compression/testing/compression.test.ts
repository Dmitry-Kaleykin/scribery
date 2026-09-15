import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticRetriever } from "../../retrieval/index.js";
import { InMemoryStorageProvider, SqliteStorageProvider, type StorageProvider } from "../../storage/index.js";
import { createChunkId, createDocumentId, createEmbeddingId, createFileRevisionId, hashText, METADATA_SCHEMA_VERSION } from "../../metadata/index.js";
import type { EmbeddingProvider } from "../../embeddings/index.js";
import { OpenAiCompatibleCompressionProvider, presentRetrievalResults, resolveCompressionOptions, type CompressionProvider, type RetrievalDiagnostics } from "../index.js";

const embedding: EmbeddingProvider = {
    identity: { provider: "fixture", model: "fixture", dimensions: 2, metric: "cosine" },
    maximumInputs: 16, maximumCharacters: 10_000,
    async embed(inputs) { return inputs.map(({ id }) => ({ id, vector: Float32Array.of(1, 0) })); },
};
const request = { repositoryId: "repo", snapshotId: "snapshot", indexBuildId: "build", query: "find the target and helper", limit: 2 };

async function seed(storage: StorageProvider, path = "a.ts", content = "const unrelated = 0;\r\nconst target = helper();\r\nconst secret = 42;\r\nfunction helper() { return 1; }\r\n", build = "build", ready = true) {
    const documentId = createDocumentId("repo", ".", path);
    const hash = hashText(content);
    const fileRevisionId = createFileRevisionId(hash);
    if (await storage.getBuild(build) === undefined) await storage.beginBuild({
        indexBuildId: build, repositoryId: "repo", snapshotId: build === "build" ? "snapshot" : "other-snapshot",
        sourceIdentity: "fixture", configurationHash: hashText("fixture"), modelIdentity: embedding.identity,
        status: "building", createdAt: new Date(0).toISOString(),
    });
    await storage.putDocument(build, { content, metadata: {
        schemaVersion: METADATA_SCHEMA_VERSION, documentId, fileRevisionId, path, filename: path,
        byteLength: Buffer.byteLength(content), byteContentHash: hash, decodedContentHash: hash,
        contentKind: "text", format: "typescript", language: "typescript", encoding: "utf-8",
        traits: [], classificationConfidence: 1,
    } });
    const lines = content.split(/(?<=\n)/u);
    let startOffset = 0;
    for (const [index, line] of lines.entries()) {
        const range = { startOffset, endOffset: startOffset + line.length, startLine: index + 1, endLine: index + 1 };
        const inputHash = hashText(line + path);
        await storage.putChunkEmbedding(build, documentId, { content: line, metadata: {
            schemaVersion: METADATA_SCHEMA_VERSION, documentId, fileRevisionId,
            chunkId: createChunkId({ fileRevisionId, chunkingIdentity: "test", range, contentHash: hashText(line) }),
            index, contentHash: hashText(line), chunkingIdentity: "test", chunkingStrategy: "cast", ...range,
        } }, { embeddingId: createEmbeddingId(inputHash, embedding.identity), inputHash, modelIdentity: embedding.identity,
            vector: index === 1 ? Float32Array.of(1, 0) : Float32Array.of(0.1, 1) }, { path, language: "typescript" });
        startOffset += line.length;
    }
    if (ready) await storage.setBuildStatus(build, "ready", new Date(1).toISOString());
    return { documentId, fileRevisionId, content };
}

describe("contextual compression", () => {
    for (const backend of ["memory", "sqlite"] as const) it(`${backend}: reads the selected revision once and preserves disjoint verbatim ranges and original scores`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "compression-"));
        const storage = backend === "memory" ? new InMemoryStorageProvider() : new SqliteStorageProvider(join(directory, "index.sqlite"));
        try {
            const fixture = await seed(storage);
            await seed(storage, "a.ts", "WRONG SNAPSHOT\n", "other-build");
            let calls = 0;
            let diagnostics: RetrievalDiagnostics | undefined;
            const provider: CompressionProvider = { async select(input) {
                calls++;
                assert.match(input.source, /function helper/u);
                assert.doesNotMatch(input.source, /WRONG SNAPSHOT/u);
                return [{ startLine: 4, endLine: 4 }, { startLine: 2, endLine: 2 }];
            } };
            const results = await new SemanticRetriever(storage, embedding, undefined, provider).retrieve({
                ...request, onDiagnostics(value) { diagnostics = value; },
            });
            assert.equal(calls, 1);
            assert.equal(results.length, 2);
            assert.equal(results[0]?.range.startLine, 2);
            assert.equal(results[0]?.content, "const target = helper();\r\n");
            const excerpts = results[0]!.compression!.excerpts;
            assert.deepEqual(excerpts.map((item) => item.range.startLine), [2, 4]);
            for (const excerpt of excerpts) {
                assert.equal(excerpt.fileRevisionId, fixture.fileRevisionId);
                assert.equal(excerpt.content, fixture.content.slice(excerpt.range.startOffset, excerpt.range.endOffset));
            }
            const presented = presentRetrievalResults(results);
            assert.equal(presented.length, 1);
            assert.ok("matchedChunks" in presented[0]!);
            assert.equal(presented[0].matchedChunks.length, 2);
            assert.ok(!("content" in presented[0]));
            assert.equal(diagnostics?.compression[0]?.status, "selected");
            assert.ok(diagnostics!.retrievalMs >= 0);
            const plain = await new SemanticRetriever(storage, embedding).retrieve({ ...request, compression: { enabled: false } });
            assert.deepEqual(results.map(({ compression: _c, ...rest }) => rest), plain);
        } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
    });

    it("keeps valid empty selections empty and reports their diagnostic", async () => {
        const storage = new InMemoryStorageProvider(); await seed(storage);
        let diagnostic: RetrievalDiagnostics | undefined;
        const results = await new SemanticRetriever(storage, embedding, undefined, { async select() { return []; } }).retrieve({
            ...request, onDiagnostics(value) { diagnostic = value; },
        });
        assert.deepEqual(results, []);
        assert.equal(diagnostic?.compression[0]?.status, "empty");
    });

    it("rejects invented ranges, reversed ranges, excess output, and provider failures without losing matches", async () => {
        for (const selection of [[{ startLine: 0, endLine: 2 }], [{ startLine: 3, endLine: 2 }], [{ startLine: 2, endLine: 200 }], [{ startLine: 1, endLine: 4 }], null]) {
            const storage = new InMemoryStorageProvider(); await seed(storage);
            const results = await new SemanticRetriever(storage, embedding, undefined, { async select() {
                if (selection === null) throw new Error("provider down"); return selection;
            } }).retrieve({ ...request, compression: { maximumExcerptCharacters: 30 } });
            assert.equal(results.length, 2);
            assert.equal(results[0]?.compression?.diagnostic.status, "fallback");
            assert.equal(results[0]?.compression?.diagnostic.reason, selection === null ? "provider-error" : "invalid-selection");
            assert.equal(results[0]?.compression?.excerpts.length, 0);
        }
    });

    it("shares a deadline across files, retains successful extraction and stops queued files", async () => {
        const storage = new InMemoryStorageProvider(); await seed(storage, "a.ts", undefined, "build", false); await seed(storage, "b.ts", undefined, "build", false); await seed(storage, "c.ts");
        let calls = 0;
        const signals: AbortSignal[] = [];
        const results = await new SemanticRetriever(storage, embedding, undefined, { async select(input) {
            calls++; signals.push(input.signal);
            if (calls === 1) return [{ startLine: 2, endLine: 2 }];
            return new Promise(() => {}); // Deliberately ignores cancellation: caller must still finish.
        } }).retrieve({ ...request, limit: 3, compression: { timeoutMs: 30 } });
        assert.equal(calls, 2);
        assert.equal(signals[1]?.aborted, true);
        assert.deepEqual(results.map((r) => r.compression?.diagnostic.status), ["selected", "fallback", "fallback"]);
        assert.deepEqual(results.slice(1).map((r) => r.compression?.diagnostic.reason), ["timeout", "timeout"]);
    });

    it("propagates cancellation rather than falling back", async () => {
        const storage = new InMemoryStorageProvider(); await seed(storage);
        const controller = new AbortController();
        const provider: CompressionProvider = { async select() { controller.abort(); return []; } };
        await assert.rejects(new SemanticRetriever(storage, embedding, undefined, provider).retrieve({ ...request, signal: controller.signal }),
            { code: "cancelled" });
    });

    it("serializes concurrent searches and includes queueing in the deadline", async () => {
        const storage = new InMemoryStorageProvider(); await seed(storage);
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let calls = 0;
        const retriever = new SemanticRetriever(storage, embedding, undefined, { async select() {
            calls++; entered(); await gate; return [{ startLine: 2, endLine: 2 }];
        } });
        const first = retriever.retrieve(request);
        await ready;
        const queued = await retriever.retrieve({ ...request, compression: { timeoutMs: 15 } });
        assert.equal(calls, 1);
        assert.equal(queued[0]?.compression?.diagnostic.reason, "timeout");
        release(); await first;
    });

    it("bounds large-file input by complete indexed ranges and rejects selections across omitted source", async () => {
        const storage = new InMemoryStorageProvider();
        await seed(storage, "a.ts", `const other = 0;\nconst target = 1;\n${"x".repeat(15_000)}\nfunction helper() {}\n`);
        let source = "";
        const results = await new SemanticRetriever(storage, embedding, undefined, { async select(input) {
            source = input.source;
            return [{ startLine: 2, endLine: 4 }];
        } }).retrieve({ ...request, limit: 1, compression: { maximumInputTokens: 2200 } });
        assert.ok(Buffer.byteLength(source) < 2200);
        assert.doesNotMatch(source, /xxx/u);
        assert.equal(results[0]?.compression?.diagnostic.inputTruncated, true);
        assert.equal(results[0]?.compression?.diagnostic.reason, "invalid-selection");
    });

    it("honors file limits and disabled profiles with an explicit override", async () => {
        const storage = new InMemoryStorageProvider(); await seed(storage, "a.ts", undefined, "build", false); await seed(storage, "b.ts");
        let calls = 0;
        const retriever = new SemanticRetriever(storage, embedding, undefined, { async select() {
            calls++; return [{ startLine: 2, endLine: 2 }];
        } }, { enabled: false });
        const disabled = await retriever.retrieve(request);
        assert.equal(calls, 0); assert.equal(disabled[0]?.compression, undefined);
        const enabled = await retriever.retrieve({ ...request, compression: { enabled: true, maximumFiles: 1 } });
        assert.equal(calls, 1);
        assert.equal(enabled[1]?.compression?.diagnostic.reason, "file-limit");
    });

    it("fails clearly when enabled without a provider and rejects invalid budgets", async () => {
        const storage = new InMemoryStorageProvider(); await seed(storage);
        await assert.rejects(new SemanticRetriever(storage, embedding).retrieve(request), /no provider is configured/u);
        assert.throws(() => resolveCompressionOptions({ timeoutMs: 30_001 }), /timeoutMs/u);
        assert.throws(() => resolveCompressionOptions({ maximumFiles: 0 }), /maximumFiles/u);
    });
});

describe("compression provider protocol", () => {
    it("uses configurable model and endpoint, disables thinking, constrains output and forwards cancellation", async () => {
        const signal = new AbortController().signal;
        const provider = new OpenAiCompatibleCompressionProvider({ model: "local-qwen-4b", baseUrl: "http://localhost:9000/v1/", apiKey: "test",
            fetch: async (url, init) => {
                assert.equal(url, "http://localhost:9000/v1/chat/completions");
                assert.equal(init?.signal, signal);
                const body = JSON.parse(String(init?.body));
                assert.equal(body.model, "local-qwen-4b");
                assert.equal(body.chat_template_kwargs.enable_thinking, false);
                assert.equal(body.max_tokens, 100);
                assert.equal(body.response_format.type, "json_schema");
                return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ranges":[{"startLine":2,"endLine":3}]}' } }] });
            },
        });
        assert.deepEqual(await provider.select({ query: "target", path: "a.ts", source: "2: target\n3: helper", maximumOutputTokens: 100, signal }), [{ startLine: 2, endLine: 3 }]);
    });
    it("rejects truncated output and malformed JSON without retrying", async () => {
        for (const choice of [{ finish_reason: "length", message: { content: '{"ranges":[]}' } }, { finish_reason: "stop", message: { content: "bad" } }]) {
            let calls = 0;
            const provider = new OpenAiCompatibleCompressionProvider({ fetch: async () => { calls++; return Response.json({ choices: [choice] }); } });
            await assert.rejects(provider.select({ query: "test", path: "a.ts", source: "1: code", maximumOutputTokens: 20, signal: new AbortController().signal }));
            assert.equal(calls, 1);
        }
    });
});
