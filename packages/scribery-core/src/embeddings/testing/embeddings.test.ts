import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    DeterministicFakeEmbeddingProvider,
    EmbeddingService,
    LmStudioEmbeddingProvider,
    formatDocumentEmbeddingInput,
    formatQueryEmbeddingInput,
} from "../index.js";

describe("embeddings", () => {
    it("returns deterministic finite fake vectors in input order", async () => {
        const service = new EmbeddingService(
            new DeterministicFakeEmbeddingProvider(8),
        );
        const progress: unknown[] = [];
        const inputs = [
            { id: "a", text: "first", mode: "document" as const },
            { id: "b", text: "second", mode: "query" as const },
        ];
        const first = await service.embed(inputs, {
            maximumInputsPerBatch: 1,
            onProgress: (event) => progress.push(event),
        });
        const second = await service.embed(inputs);

        assert.deepEqual(first, second);
        assert.deepEqual(first.map(({ id }) => id), ["a", "b"]);
        assert.equal(first[0]?.vector.length, 8);
        assert.deepEqual(progress, [
            {
                completedInputs: 0,
                totalInputs: 2,
                completedBatches: 0,
                totalBatches: 2,
            },
            {
                completedInputs: 1,
                totalInputs: 2,
                completedBatches: 1,
                totalBatches: 2,
            },
            {
                completedInputs: 2,
                totalInputs: 2,
                completedBatches: 2,
                totalBatches: 2,
            },
        ]);
    });

    it("streams bounded batches without starting the next batch early", async () => {
        const service = new EmbeddingService(
            new DeterministicFakeEmbeddingProvider(4),
        );
        const batches = service.embedBatches([
            { id: "a", text: "first", mode: "document" },
            { id: "b", text: "second", mode: "document" },
            { id: "c", text: "third", mode: "document" },
        ], { maximumInputsPerBatch: 2 });
        const first = await batches.next();

        assert.equal(first.done, false);
        assert.deepEqual(
            first.value?.results.map(({ id }) => id),
            ["a", "b"],
        );
        assert.deepEqual(first.value?.progress, {
            completedInputs: 2,
            totalInputs: 3,
            completedBatches: 1,
            totalBatches: 2,
        });

        const second = await batches.next();
        assert.equal(second.done, false);
        assert.deepEqual(
            second.value?.results.map(({ id }) => id),
            ["c"],
        );
        assert.equal((await batches.next()).done, true);
    });

    it("uses the OpenAI-compatible embeddings endpoint", async () => {
        let requestUrl = "";
        let requestBody: unknown;
        const provider = new LmStudioEmbeddingProvider({
            model: "embedding-model",
            dimensions: 3,
            baseUrl: "http://localhost:1234/v1/",
            fetch: async (input, init) => {
                requestUrl = String(input);
                requestBody = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({
                    data: [
                        { index: 1, embedding: [0, 1, 0] },
                        { index: 0, embedding: [1, 0, 0] },
                    ],
                }), { status: 200 });
            },
        });
        const results = await new EmbeddingService(provider).embed([
            { id: "first", text: "one", mode: "document" },
            { id: "second", text: "two", mode: "document" },
        ]);

        assert.equal(requestUrl, "http://localhost:1234/v1/embeddings");
        assert.deepEqual(requestBody, {
            model: "embedding-model",
            input: ["one", "two"],
        });
        assert.deepEqual(results.map(({ id }) => id), ["first", "second"]);
    });

    it("applies an embedding suffix after document and query content", () => {
        const suffix = "<|endoftext|>";
        const document = formatDocumentEmbeddingInput(
            "document",
            {
                path: "src/example.ts",
                language: "typescript",
                content: "export const answer = 42;",
            },
            "document: ",
            suffix,
        );
        const query = formatQueryEmbeddingInput(
            "query",
            "find answer",
            "query: ",
            suffix,
        );

        assert.match(document.text, /^document: formatter:/u);
        assert.ok(document.text.endsWith(
            "export const answer = 42;<|endoftext|>",
        ));
        assert.equal(query.text, "query: find answer<|endoftext|>");
    });

    it("adds parent symbols to orphaned body fragments without changing code", () => {
        const content = "        this.cache.set(key, value);\n";
        const input = formatDocumentEmbeddingInput("chunk", {
            path: "src/resolution.ts",
            language: "typescript",
            content,
            semanticContext: {
                scope: [{
                    name: "Resolution",
                    kind: "class",
                    signature: "export class Resolution",
                }, {
                    name: "init",
                    kind: "method",
                    signature: "init(data: ResolutionData): void",
                }],
                symbols: [],
                imports: [],
            },
        });

        assert.doesNotMatch(content, /Resolution|init/u);
        assert.match(input.text, /scope: class Resolution > method init/u);
        assert.ok(input.text.endsWith(`\n\n${content}`));
    });

    it("rejects invalid provider configuration before making a request", () => {
        assert.throws(() => new DeterministicFakeEmbeddingProvider(0));
        assert.throws(() => new LmStudioEmbeddingProvider({
            model: "embedding-model",
            dimensions: 3,
            baseUrl: "file:///not-an-http-endpoint",
        }));
    });

    it("reports expected and returned vector dimensions", async () => {
        const provider = new LmStudioEmbeddingProvider({
            model: "embedding-model",
            dimensions: 3,
            fetch: async () => new Response(JSON.stringify({
                data: [{ index: 0, embedding: [1, 0] }],
            }), { status: 200 }),
        });

        await assert.rejects(
            new EmbeddingService(provider).embed([{
                id: "dimension-check",
                text: "check",
                mode: "query",
            }]),
            (error: unknown) =>
                error instanceof Error &&
                "code" in error &&
                error.code === "invalid-provider-response" &&
                error.message.includes("expected 3, received 2") &&
                "details" in error &&
                (error.details as { actualDimensions?: number })
                    .actualDimensions === 2,
        );
    });

    it("preserves the provider's error message and response body", async () => {
        const provider = new LmStudioEmbeddingProvider({
            model: "embedding-model",
            dimensions: 3,
            fetch: async () => new Response(JSON.stringify({
                error: {
                    message: "Model is not an embedding model",
                    type: "invalid_request_error",
                },
            }), { status: 400 }),
        });

        await assert.rejects(
            provider.embed([{
                id: "failure",
                text: "check",
                mode: "document",
            }]),
            (error: unknown) =>
                error instanceof Error &&
                error.message === "Model is not an embedding model" &&
                "details" in error &&
                (error.details as { status?: number }).status === 400 &&
                typeof (error.details as { responseBody?: unknown }).responseBody ===
                    "string",
        );
    });
});
