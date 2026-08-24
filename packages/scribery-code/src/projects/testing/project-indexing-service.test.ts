import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ProviderProfileService } from "scribery-core";
import {
    ProjectIndexingService,
    ProjectInspectionService,
    ProjectSearchService,
    ProjectRetrievalTargetService,
    type ProjectIndexingEvent,
} from "../index.js";

describe("project indexing service", () => {
    it("saves a recipe, emits stable events, and reindexes from it", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-index-service-"));
        const indexesDirectory = join(directory, "indexes");
        const profilesPath = join(directory, "provider-profiles.json");
        const root = join(directory, "project");
        await mkdir(root, { recursive: true });
        await writeFile(
            join(root, "example.ts"),
            "export const version = 1;\n",
            "utf8",
        );
        await writeFile(
            join(root, "unchanged.ts"),
            "export const stable = true;\n",
            "utf8",
        );
        const fetch = createEmbeddingFetch();
        await new ProviderProfileService({ profilesPath, fetch }).set({
            name: "local-qwen",
            embedding: {
                provider: "lm-studio",
                model: "fixture-embedding",
                dimensions: 3,
                maximumInputs: 4,
            },
            reranking: {
                provider: "lm-studio-qwen3",
                model: "fixture-reranker",
            },
        });
        const service = new ProjectIndexingService({
            indexesDirectory,
            profilesPath,
            fetch,
        });
        const events: ProjectIndexingEvent[] = [];
        const first = await service.index({
            root,
            provider: { type: "profile", profile: "local-qwen" },
            target: "main",
            keepReplacedBuilds: 1,
            windows1251: true,
            maximumChunkSize: 500,
            onEvent: (event) => events.push(event),
        });

        assert.equal(first.project?.root, root);
        assert.equal(first.recipe?.provider.type, "profile");
        assert.equal(first.recipe?.target, "main");
        assert.equal(first.recipe?.windows1251, true);
        assert.ok(events.every(({ schemaVersion }) => schemaVersion === 1));
        assert.equal(events[0]?.type, "provider-diagnostic");
        assert.equal(events.at(-1)?.type, "operation-complete");
        assert.ok(events.some(({ type }) => type === "target-publication"));
        assert.ok(events.some(({ type }) => type === "recipe-save"));

        await writeFile(
            join(root, "example.ts"),
            "export const version = 2;\n",
            "utf8",
        );
        const reindexEvents: ProjectIndexingEvent[] = [];
        const second = await service.reindex(
            root,
            root,
            (event) => reindexEvents.push(event),
        );
        assert.notEqual(second.result.indexBuildId, first.result.indexBuildId);
        assert.equal(second.result.reusedDocuments, 1);
        assert.equal(second.result.generatedEmbeddings, 1);
        assert.equal(second.recipe?.target, "main");
        assert.equal(reindexEvents.at(-1)?.type, "operation-complete");

        const retrieval = new ProjectRetrievalTargetService({
            indexesDirectory,
        });
        assert.deepEqual((await retrieval.status(undefined, root)).active, {
            type: "target",
            target: "main",
            indexBuildId: second.result.indexBuildId,
        });
        const recipe = await service.recipe(undefined, root);
        assert.equal(recipe?.provider.type, "profile");
        assert.equal(recipe?.target, "main");

        const search = await new ProjectSearchService({
            indexesDirectory,
            profilesPath,
            fetch,
        }).search({
            query: "where is version defined?",
            projectReference: root,
            profile: "local-qwen",
            limit: 1,
        });
        assert.equal(search.indexBuildId, second.result.indexBuildId);
        assert.equal(search.resultCount, 1);
        assert.equal(search.results[0]?.rerankScore, 1);

        const inspection = await new ProjectInspectionService({
            indexesDirectory,
        }).chunks({
            path: "example.ts",
            projectReference: root,
        });
        assert.equal(inspection.indexBuildId, second.result.indexBuildId);
        assert.equal(inspection.chunks.chunks.length, 1);
    });
});

function createEmbeddingFetch(): typeof globalThis.fetch {
    return async (input, init) => {
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
        const body = JSON.parse(String(init?.body)) as {
            input: readonly string[];
        };
        return Response.json({
            data: body.input.map((_text, index) => ({
                index,
                embedding: [1, index / 10, 0],
            })),
        });
    };
}
