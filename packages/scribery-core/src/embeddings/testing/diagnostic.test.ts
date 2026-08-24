import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EmbeddingModelIdentity } from "../../metadata/index.js";
import {
    diagnoseEmbeddingProvider,
    EmbeddingError,
    type EmbeddingInput,
    type EmbeddingProvider,
    type EmbeddingResult,
} from "../index.js";

describe("embedding provider diagnostic", () => {
    it("sends one representative document and validates its dimensions", async () => {
        const provider = new RecordingDiagnosticProvider();
        const result = await diagnoseEmbeddingProvider(provider);

        assert.deepEqual(result, {
            provider: "diagnostic-fixture",
            model: "diagnostic-model",
            dimensions: 4,
        });
        assert.equal(provider.inputs.length, 1);
        assert.equal(provider.inputs[0]?.mode, "document");
        assert.match(provider.inputs[0]?.text ?? "", /^document: /u);
        assert.match(provider.inputs[0]?.text ?? "", /kind: diagnostic/u);
        assert.ok(provider.inputs[0]?.text.endsWith("<|endoftext|>"));
    });

    it("wraps the provider failure with diagnostic context", async () => {
        const provider = new FailingDiagnosticProvider();

        await assert.rejects(
            diagnoseEmbeddingProvider(provider),
            (error: unknown) =>
                error instanceof EmbeddingError &&
                error.code === "diagnostic-failed" &&
                error.details.model === "unavailable-model" &&
                error.details.expectedDimensions === 8 &&
                error.cause instanceof EmbeddingError &&
                error.cause.code === "provider-unavailable",
        );
    });
});

class RecordingDiagnosticProvider implements EmbeddingProvider {
    readonly identity: EmbeddingModelIdentity = {
        provider: "diagnostic-fixture",
        model: "diagnostic-model",
        dimensions: 4,
        metric: "cosine",
        documentPrefix: "document: ",
        embeddingSuffix: "<|endoftext|>",
    };
    readonly maximumInputs = 2;
    readonly maximumCharacters = 1_000;
    inputs: readonly EmbeddingInput[] = [];

    async embed(
        inputs: readonly EmbeddingInput[],
    ): Promise<readonly EmbeddingResult[]> {
        this.inputs = inputs;
        return inputs.map(({ id }) => ({
            id,
            vector: Float32Array.from([1, 0, 0, 0]),
        }));
    }
}

class FailingDiagnosticProvider implements EmbeddingProvider {
    readonly identity: EmbeddingModelIdentity = {
        provider: "diagnostic-fixture",
        model: "unavailable-model",
        dimensions: 8,
        metric: "cosine",
    };
    readonly maximumInputs = 2;
    readonly maximumCharacters = 1_000;

    async embed(): Promise<never> {
        throw new EmbeddingError(
            "provider-unavailable",
            "No embedding model is loaded",
            { status: 400 },
        );
    }
}
