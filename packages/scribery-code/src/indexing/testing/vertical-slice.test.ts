import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
    DeterministicFakeEmbeddingProvider,
    EmbeddingError,
    IndexingError,
    type IndexingProgress,
    type EmbeddingInput,
    type EmbeddingProvider,
    type EmbeddingProviderOptions,
    type EmbeddingResult,
} from "scribery-core";
import type { EmbeddingModelIdentity } from "scribery-core";
import { SemanticRetriever } from "scribery-core";
import { InMemoryStorageProvider } from "scribery-core";
import {
    IndexingCoordinator,
} from "../index.js";

describe("indexing vertical slice", () => {
    it("indexes target formats, legacy encoding, and retrieves exact attribution", async () => {
        const root = await createProjectFixture();
        const storage = new InMemoryStorageProvider();
        const provider = new CountingEmbeddingProvider(16);
        const coordinator = new IndexingCoordinator(storage, provider);
        const progress: IndexingProgress[] = [];
        const result = await coordinator.index({
            root,
            repositoryIdentity: "vertical-slice-fixture",
            maximumChunkSize: 80,
            maximumEmbeddingInputsPerBatch: 2,
            encodingFallback: "windows-1251",
            onProgress: (event) => progress.push(event),
        });

        assert.equal(result.discoveredFiles, 9);
        assert.equal(result.indexedDocuments, 9);
        assert.ok(result.indexedChunks >= 9);
        assert.equal(result.reusedDocuments, 0);
        assert.equal(result.reusedChunks, 0);
        assert.equal(result.reusedEmbeddings, 0);
        assert.equal(provider.documentInputs, result.generatedEmbeddings);
        assert.ok(provider.documentBatchSizes.length > 1);
        assert.ok(provider.documentBatchSizes.every((size) => size <= 2));
        assert.deepEqual(result.diagnostics, []);
        assert.deepEqual(
            [...new Set(progress.map(({ phase }) => phase))],
            [
                "source-inspection",
                "discovery",
                "preparing-build",
                "processing",
                "embedding",
                "storage",
                "finalizing",
                "complete",
            ],
        );
        assert.ok(progress.some((event) =>
            event.phase === "processing" &&
            event.completed === event.total &&
            event.total === result.discoveredFiles
        ));
        assert.ok(progress.some((event) =>
            event.phase === "processing" &&
            event.activity === "chunking" &&
            event.currentPath === "src/App.vue" &&
            event.completed !== undefined &&
            event.total === result.discoveredFiles
        ));
        assert.ok(progress.some((event) =>
            event.phase === "embedding" &&
            event.completed === event.total &&
            event.total === result.indexedChunks
        ));

        const vueDocument = await storage.getDocumentChunks({
            indexBuildId: result.indexBuildId,
            path: "src/App.vue",
        });
        assert.ok(vueDocument);
        assert.ok(vueDocument.document.content.includes("\n\n"));
        assert.ok(vueDocument.chunks.length > 1);
        assert.ok(vueDocument.chunks.every(({ content }) =>
            content.trim().length > 0
        ));
        assert.deepEqual(
            vueDocument.chunks.map(({ metadata }) => metadata.index),
            vueDocument.chunks.map((_, index) => index),
        );

        const retriever = new SemanticRetriever(storage, provider);
        const phpResults = await retriever.retrieve({
            repositoryId: result.repositoryId,
            snapshotId: result.snapshotId,
            indexBuildId: result.indexBuildId,
            query: "Russian greeting",
            filters: [{
                field: "language",
                operator: "equals",
                value: "php",
            }],
            limit: 20,
        });

        assert.ok(phpResults.length > 0);
        assert.ok(phpResults.every(({ language }) => language === "php"));
        assert.ok(phpResults.some(({ path }) => path === "legacy/greeting.inc"));
        assert.ok(phpResults.some(({ content }) => content.includes("Привет")));
        assert.ok(phpResults.every(({ range, content }) =>
            range.endOffset > range.startOffset && content.length > 0
        ));

        const repeated = await coordinator.index({
            root,
            repositoryIdentity: "vertical-slice-fixture",
            maximumChunkSize: 80,
            encodingFallback: "windows-1251",
        });
        assert.equal(repeated.reused, true);
        assert.equal(repeated.indexBuildId, result.indexBuildId);
        assert.equal(provider.documentInputs, result.indexedChunks);

        const documentInputsBeforeEncodingVariation = provider.documentInputs;
        const encodingVariation = await coordinator.index({
            root,
            repositoryIdentity: "vertical-slice-fixture",
            maximumChunkSize: 80,
        });
        assert.equal(encodingVariation.reused, false);
        assert.equal(encodingVariation.indexedDocuments, 8);
        assert.equal(encodingVariation.reusedDocuments, 8);
        assert.equal(encodingVariation.indexedChunks, encodingVariation.reusedChunks);
        assert.equal(encodingVariation.reusedEmbeddings, 0);
        assert.equal(encodingVariation.generatedEmbeddings, 0);
        assert.equal(provider.documentInputs, documentInputsBeforeEncodingVariation);

        await writeFile(
            join(root, "src", "main.ts"),
            "export function answer(): number { return 43; }\n",
        );
        const documentInputsBeforeIncrementalBuild = provider.documentInputs;
        const incremental = await coordinator.index({
            root,
            repositoryIdentity: "vertical-slice-fixture",
            maximumChunkSize: 80,
            encodingFallback: "windows-1251",
        });

        assert.equal(incremental.reused, false);
        assert.notEqual(incremental.snapshotId, result.snapshotId);
        assert.equal(incremental.indexedDocuments, 9);
        assert.equal(incremental.reusedDocuments, 8);
        assert.ok(incremental.reusedChunks >= 8);
        assert.equal(
            provider.documentInputs - documentInputsBeforeIncrementalBuild,
            incremental.generatedEmbeddings,
        );

        const changedResults = await retriever.retrieve({
            repositoryId: incremental.repositoryId,
            snapshotId: incremental.snapshotId,
            indexBuildId: incremental.indexBuildId,
            query: "answer implementation",
            filters: [{
                field: "path",
                operator: "equals",
                value: "src/main.ts",
            }],
            limit: 20,
        });
        const originalResults = await retriever.retrieve({
            repositoryId: result.repositoryId,
            snapshotId: result.snapshotId,
            indexBuildId: result.indexBuildId,
            query: "answer implementation",
            filters: [{
                field: "path",
                operator: "equals",
                value: "src/main.ts",
            }],
            limit: 20,
        });
        assert.ok(changedResults.some(({ content }) => content.includes("43")));
        assert.ok(originalResults.some(({ content }) => content.includes("42")));
        assert.ok(originalResults.every(({ content }) => !content.includes("43")));

        const documentInputsBeforeIncompatibleBuild = provider.documentInputs;
        const incompatible = await coordinator.index({
            root,
            repositoryIdentity: "vertical-slice-fixture",
            maximumChunkSize: 81,
            encodingFallback: "windows-1251",
        });
        assert.equal(incompatible.reusedDocuments, 0);
        assert.equal(incompatible.reusedChunks, 0);
        assert.equal(
            incompatible.reusedEmbeddings + incompatible.generatedEmbeddings,
            incompatible.indexedChunks,
        );
        assert.ok(incompatible.reusedEmbeddings > 0);
        assert.equal(
            provider.documentInputs - documentInputsBeforeIncompatibleBuild,
            incompatible.generatedEmbeddings,
        );
    });

    it("preserves embedding dimension failures as the indexing cause", async () => {
        const root = await createProjectFixture();
        const provider = new WrongDimensionEmbeddingProvider();
        const coordinator = new IndexingCoordinator(
            new InMemoryStorageProvider(),
            provider,
        );

        await assert.rejects(
            coordinator.index({
                root,
                repositoryIdentity: "wrong-dimension-fixture",
                maximumChunkSize: 80,
                encodingFallback: "windows-1251",
            }),
            (error: unknown) =>
                error instanceof IndexingError &&
                error.code === "indexing-failed" &&
                error.cause instanceof EmbeddingError &&
                error.cause.code === "invalid-provider-response" &&
                error.cause.details.expectedDimensions === 3 &&
                error.cause.details.actualDimensions === 2,
        );
    });
});

class CountingEmbeddingProvider implements EmbeddingProvider {
    readonly #delegate: DeterministicFakeEmbeddingProvider;
    readonly identity: EmbeddingModelIdentity;
    readonly maximumInputs: number;
    readonly maximumCharacters: number;
    documentInputs = 0;
    queryInputs = 0;
    readonly documentBatchSizes: number[] = [];

    constructor(dimensions: number) {
        this.#delegate = new DeterministicFakeEmbeddingProvider(dimensions);
        this.identity = this.#delegate.identity;
        this.maximumInputs = this.#delegate.maximumInputs;
        this.maximumCharacters = this.#delegate.maximumCharacters;
    }

    async embed(
        inputs: readonly EmbeddingInput[],
        options: EmbeddingProviderOptions = {},
    ): Promise<readonly EmbeddingResult[]> {
        const documentInputs = inputs.filter(({ mode }) => mode === "document");
        this.documentInputs += documentInputs.length;
        this.queryInputs += inputs.filter(({ mode }) => mode === "query").length;
        if (documentInputs.length > 0) {
            this.documentBatchSizes.push(documentInputs.length);
        }
        return this.#delegate.embed(inputs, options);
    }
}

class WrongDimensionEmbeddingProvider implements EmbeddingProvider {
    readonly identity: EmbeddingModelIdentity = {
        provider: "wrong-dimension-fixture",
        model: "fixture-v1",
        dimensions: 3,
        metric: "cosine",
    };
    readonly maximumInputs = 128;
    readonly maximumCharacters = 1_000_000;

    async embed(
        inputs: readonly EmbeddingInput[],
    ): Promise<readonly EmbeddingResult[]> {
        return inputs.map(({ id }) => ({
            id,
            vector: Float32Array.of(1, 0),
        }));
    }
}

async function createProjectFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "scribery-project-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "legacy"));
    await mkdir(join(root, "templates"));
    await mkdir(join(root, "styles"));
    await writeFile(
        join(root, "src", "main.ts"),
        "export function answer(): number { return 42; }\n",
    );
    await writeFile(
        join(root, "src", "duplicate.ts"),
        "export function answer(): number { return 42; }\n",
    );
    await writeFile(
        join(root, "src", "App.vue"),
        [
            "<template>",
            `    <main>${"Hello ".repeat(20)}</main>`,
            "</template>",
            "",
            "<script setup lang=\"ts\">",
            ...Array.from(
                { length: 8 },
                (_, index) => `const value${index}: number = ${index};`,
            ),
            "</script>",
            "",
            "<style scoped>",
            ...Array.from(
                { length: 8 },
                (_, index) => `.item-${index} { color: red; }`,
            ),
            "</style>",
            "",
        ].join("\n"),
    );
    await writeFile(join(root, "index.html"), "<main>Hello</main>\n");
    await writeFile(join(root, "data.json"), "{\"items\":[1,2,3]}\n");
    await writeFile(
        join(root, "styles", "app.css"),
        ".app { color: #245edb; }\n",
    );
    await writeFile(
        join(root, "styles", "theme.scss"),
        "$brand: #245edb;\n.app { color: $brand; }\n",
    );
    await writeFile(
        join(root, "templates", "page.twig"),
        "<main>{{ title }}</main>\n",
    );
    await writeFile(
        join(root, "legacy", "greeting.inc"),
        Uint8Array.from([
            ...new TextEncoder().encode("<?php\r\n$message = \""),
            0xcf,
            0xf0,
            0xe8,
            0xe2,
            0xe5,
            0xf2,
            ...new TextEncoder().encode("\";\r\n"),
        ]),
    );
    return root;
}
