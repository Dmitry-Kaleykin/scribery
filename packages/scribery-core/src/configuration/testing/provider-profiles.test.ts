import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
    ProviderProfileService,
} from "../index.js";

describe("provider profiles", () => {
    it("creates, updates, lists, diagnoses, and removes named profiles", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-profiles-"));
        const profilesPath = join(directory, "provider-profiles.json");
        const requests: unknown[] = [];
        const service = new ProviderProfileService({
            profilesPath,
            fetch: async (input, init) => {
                if (String(input).endsWith("/models")) {
                    return Response.json({
                        data: [
                            { id: "reranker", object: "model" },
                            { id: "embedding", owned_by: "local" },
                        ],
                    });
                }
                if (String(input).endsWith("/completions")) {
                    return Response.json({
                        choices: [{
                            index: 0,
                            text: "yes",
                            logprobs: null,
                            finish_reason: "length",
                        }],
                        usage: { completion_tokens: 1 },
                    });
                }
                if (String(input).endsWith("/rerank")) {
                    return Response.json({
                        results: [{ index: 0, relevance_score: 0.91 }],
                    });
                }
                requests.push(JSON.parse(String(init?.body)));
                return Response.json({
                    data: [{ index: 0, embedding: [1, 0, 0] }],
                });
            },
        });

        const created = await service.set({
            name: "local-qwen",
            embedding: {
                provider: "lm-studio",
                model: "qwen-embedding",
                dimensions: 3,
                baseUrl: "http://127.0.0.1:1234/v1/",
                maximumInputs: 8,
                embeddingSuffix: "<|endoftext|>",
            },
            reranking: {
                provider: "lm-studio-qwen3",
                model: "qwen-reranker",
            },
        });
        assert.equal(created.name, "local-qwen");
        assert.equal(created.embedding.provider, "openai-compatible");
        assert.equal(created.reranking?.provider, "openai-compatible-qwen3");
        assert.equal(created.embedding.baseUrl, "http://127.0.0.1:1234/v1");
        assert.equal((await service.list()).length, 1);
        assert.equal((await service.get("local-qwen")).reranking?.model, "qwen-reranker");
        assert.deepEqual(
            (await service.listProviderModels()).map(({ id }) => id),
            ["embedding", "reranker"],
        );
        assert.equal(
            (await service.inspectEmbeddingModel("qwen-embedding"))
                .dimensions,
            3,
        );

        const diagnostic = await service.diagnose("local-qwen");
        assert.equal(diagnostic.embedding.provider, "openai-compatible");
        assert.equal(diagnostic.embedding.dimensions, 3);
        assert.equal(diagnostic.reranking?.provider, "openai-compatible-qwen3");
        assert.equal(diagnostic.reranking?.score, 1);
        assert.equal(
            (requests[1] as { model: string }).model,
            "qwen-embedding",
        );

        const dedicated = await service.set({
            name: "local-qwen",
            embedding: created.embedding,
            reranking: {
                provider: "openai-compatible-rerank",
                model: "Qwen3-Reranker-0.6B-mxfp8",
                baseUrl: "http://127.0.0.1:8000/v1/",
            },
        });
        assert.equal(dedicated.reranking?.provider, "openai-compatible-rerank");
        assert.equal(dedicated.reranking?.baseUrl, "http://127.0.0.1:8000/v1");
        const dedicatedDiagnostic = await service.diagnose("local-qwen");
        assert.equal(dedicatedDiagnostic.reranking?.provider, "openai-compatible-rerank");
        assert.equal(dedicatedDiagnostic.reranking?.score, 0.91);

        const updated = await service.set({
            name: "local-qwen",
            embedding: {
                provider: "openai-compatible",
                model: "qwen-embedding-v2",
                dimensions: 3,
            },
        });
        assert.equal(updated.createdAt, created.createdAt);
        assert.equal(updated.embedding.model, "qwen-embedding-v2");
        assert.equal(updated.reranking, undefined);

        assert.deepEqual(await service.remove("local-qwen"), {
            removed: "local-qwen",
            profileCount: 0,
        });
        await assert.rejects(service.get("local-qwen"), /was not found/u);
    });
});
