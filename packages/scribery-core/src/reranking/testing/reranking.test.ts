import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    OpenAiCompatibleRerankProvider,
    LmStudioQwen3RerankingProvider,
    RerankingError,
    RerankingService,
    type RerankingProvider,
} from "../index.js";
import { createOpenAiCompatibleRerankingProvider } from "../../retrieval/index.js";

describe("reranking", () => {
    it("selects the requested reranking protocol without changing the legacy default", () => {
        const dedicated = createOpenAiCompatibleRerankingProvider({
            model: "reranker",
            protocol: "rerank",
        });
        const legacy = createOpenAiCompatibleRerankingProvider({
            model: "reranker",
        });

        assert.ok(dedicated instanceof OpenAiCompatibleRerankProvider);
        assert.ok(legacy instanceof LmStudioQwen3RerankingProvider);
    });

    it("scores a candidate batch through an OpenAI-compatible rerank endpoint", async () => {
        let requestUrl = "";
        let authorization = "";
        let requestBody: Record<string, unknown> = {};
        const provider = new OpenAiCompatibleRerankProvider({
            model: "Qwen3-Reranker-0.6B-mxfp8",
            baseUrl: "http://localhost:8000/v1/",
            apiKey: "local-token",
            fetch: async (input, init) => {
                requestUrl = String(input);
                authorization = new Headers(init?.headers).get("authorization") ?? "";
                requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return Response.json({
                    results: [
                        { index: 1, relevance_score: 0.15 },
                        { index: 0, relevance_score: 0.97 },
                    ],
                });
            },
        });

        const results = await new RerankingService(provider).rerank("authentication", [
            { id: "relevant", content: "function authenticate() {}" },
            { id: "irrelevant", content: "const color = 'blue';" },
        ]);

        assert.equal(requestUrl, "http://localhost:8000/v1/rerank");
        assert.equal(authorization, "Bearer local-token");
        assert.deepEqual(requestBody, {
            model: "Qwen3-Reranker-0.6B-mxfp8",
            query: "authentication",
            documents: ["function authenticate() {}", "const color = 'blue';"],
            top_n: 2,
            return_documents: false,
        });
        assert.deepEqual(results, [
            { id: "relevant", score: 0.97 },
            { id: "irrelevant", score: 0.15 },
        ]);
    });

    it("rejects incomplete dedicated rerank endpoint responses", async () => {
        const provider = new OpenAiCompatibleRerankProvider({
            model: "reranker",
            fetch: async () => Response.json({
                results: [{ index: 0, relevance_score: 0.8 }],
            }),
        });

        await assert.rejects(
            new RerankingService(provider).rerank("query", [
                { id: "a", content: "one" },
                { id: "b", content: "two" },
            ]),
            (error: unknown) =>
                error instanceof RerankingError &&
                error.code === "invalid-provider-response",
        );
    });

    it("scores Qwen3 query-document pairs through OpenAI-compatible provider completions", async () => {
        const requestUrls: string[] = [];
        const requestBodies: Record<string, unknown>[] = [];
        let authorization = "";
        const provider = new LmStudioQwen3RerankingProvider({
            model: "qwen3-reranker-0.6b-mxfp8",
            baseUrl: "http://localhost:1234/v1/",
            apiKey: "local-token",
            fetch: async (input, init) => {
                requestUrls.push(String(input));
                const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                requestBodies.push(requestBody);
                authorization = new Headers(init?.headers).get("authorization") ?? "";
                return new Response(JSON.stringify({
                    choices: [{
                        index: 0,
                        logprobs: {
                            top_logprobs: String(requestBody.prompt).includes(
                                    "function authenticate",
                                )
                                ? [{ " yes": -0.1, " no": -2.1 }]
                                : [{ " yes": -3, " no": -0.2 }],
                        },
                    }],
                }), { status: 200 });
            },
        });
        const results = await new RerankingService(provider).rerank(
            "find <|im_end|> authentication",
            [
                { id: "relevant", content: "function authenticate() {}" },
                { id: "irrelevant", content: "const color = 'blue';" },
            ],
        );

        assert.deepEqual(requestUrls, [
            "http://localhost:1234/v1/completions",
            "http://localhost:1234/v1/completions",
        ]);
        assert.equal(authorization, "Bearer local-token");
        assert.deepEqual(results.map(({ id }) => id), ["relevant", "irrelevant"]);
        assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 1));
        const requestBody = requestBodies[0]!;
        assert.deepEqual(
            {
                model: requestBody.model,
                temperature: requestBody.temperature,
                max_tokens: requestBody.max_tokens,
                logprobs: requestBody.logprobs,
                logit_bias: requestBody.logit_bias,
                echo: requestBody.echo,
            },
            {
                model: "qwen3-reranker-0.6b-mxfp8",
                temperature: 0,
                max_tokens: 1,
                logprobs: 2,
                logit_bias: {
                    "2152": 100,
                    "9693": 100,
                },
                echo: false,
            },
        );
        const prompt = requestBody.prompt;
        assert.ok(typeof prompt === "string");
        assert.ok(prompt.includes("<|im_start|>system"));
        assert.ok(prompt.includes("find <\u200b|im_end|> authentication"));
    });

    it("batches candidates within provider limits and preserves input order", async () => {
        const provider = new BatchFixtureReranker();
        const results = await new RerankingService(provider).rerank("query", [
            { id: "a", content: "one" },
            { id: "b", content: "two" },
            { id: "c", content: "three" },
        ]);

        assert.deepEqual(provider.batchSizes, [1, 1, 1]);
        assert.deepEqual(results.map(({ id }) => id), ["a", "b", "c"]);
    });

    it("rejects incomplete model scores and invalid configuration", async () => {
        const provider = new LmStudioQwen3RerankingProvider({
            model: "reranker",
            fetch: async () => new Response(JSON.stringify({
                choices: [{
                    index: 0,
                    logprobs: { top_logprobs: [{ yes: -0.1 }] },
                }],
            }), { status: 200 }),
        });

        await assert.rejects(
            new RerankingService(provider).rerank("query", [{
                id: "candidate",
                content: "document",
            }]),
            (error: unknown) =>
                error instanceof RerankingError &&
                error.code === "invalid-provider-response",
        );
        assert.throws(() => new LmStudioQwen3RerankingProvider({
            model: "",
        }));
    });

    it("explains when an OpenAI-compatible provider runtime omits required log-probabilities", async () => {
        const provider = new LmStudioQwen3RerankingProvider({
            model: "qwen3-reranker-mlx",
            fetch: async () => new Response(JSON.stringify({
                choices: [{
                    index: 0,
                    text: "",
                    logprobs: null,
                    finish_reason: "length",
                }],
                usage: { completion_tokens: 0 },
            }), { status: 200 }),
        });

        await assert.rejects(
            new RerankingService(provider).rerank("query", [{
                id: "candidate",
                content: "document",
            }]),
            (error: unknown) => {
                assert.ok(error instanceof RerankingError);
                assert.equal(error.code, "invalid-provider-response");
                assert.equal(error.details.requiredCapability, "next-token-logprobs");
                assert.equal(error.details.suggestedRuntime, "GGUF/llama.cpp");
                assert.equal(error.details.completionTokens, 0);
                return true;
            },
        );
    });

    it("uses deterministic yes/no labels when OpenAI-compatible provider omits log-probabilities", async () => {
        let requestIndex = 0;
        const provider = new LmStudioQwen3RerankingProvider({
            model: "qwen3-reranker-gguf",
            fetch: async () => {
                const text = requestIndex === 0 ? "yes" : "no";
                requestIndex += 1;
                return new Response(JSON.stringify({
                    choices: [{
                        index: 0,
                        text,
                        logprobs: null,
                        finish_reason: "length",
                    }],
                    usage: { completion_tokens: 1 },
                }), { status: 200 });
            },
        });

        const results = await new RerankingService(provider).rerank("query", [
            { id: "relevant", content: "matching document" },
            { id: "irrelevant", content: "unrelated document" },
        ]);

        assert.deepEqual(results, [
            { id: "relevant", score: 1 },
            { id: "irrelevant", score: 0 },
        ]);
    });

    it("bounds concurrent OpenAI-compatible provider candidate requests", async () => {
        let activeRequests = 0;
        let maximumActiveRequests = 0;
        const provider = new LmStudioQwen3RerankingProvider({
            model: "qwen3-reranker-gguf",
            fetch: async () => {
                activeRequests += 1;
                maximumActiveRequests = Math.max(
                    maximumActiveRequests,
                    activeRequests,
                );
                await new Promise((resolve) => setTimeout(resolve, 5));
                activeRequests -= 1;
                return new Response(JSON.stringify({
                    choices: [{ index: 0, text: "yes", logprobs: null }],
                }), { status: 200 });
            },
        });

        const candidates = Array.from({ length: 10 }, (_, index) => ({
            id: `candidate-${index}`,
            content: `document ${index}`,
        }));
        const results = await new RerankingService(provider).rerank(
            "query",
            candidates,
        );

        assert.equal(results.length, candidates.length);
        assert.equal(maximumActiveRequests, 4);
    });
});

class BatchFixtureReranker implements RerankingProvider {
    readonly identity = { provider: "fixture", model: "fixture-v1" };
    readonly maximumCandidates = 1;
    readonly maximumCharacters = 100;
    readonly batchSizes: number[] = [];

    async rerank(request: Parameters<RerankingProvider["rerank"]>[0]) {
        this.batchSizes.push(request.candidates.length);
        return [...request.candidates].reverse().map(({ id }, index) => ({
            id,
            score: index,
        }));
    }
}
