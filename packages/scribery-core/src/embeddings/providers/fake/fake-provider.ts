import { createHash } from "node:crypto";

import type { EmbeddingModelIdentity } from "../../../metadata/index.js";
import type {
    EmbeddingInput,
    EmbeddingProvider,
    EmbeddingProviderOptions,
    EmbeddingResult,
} from "../../contracts/embedding.js";
import { EmbeddingError } from "../../errors/embedding-error.js";

export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
    readonly identity: EmbeddingModelIdentity;
    readonly maximumInputs = 128;
    readonly maximumCharacters = 1_000_000;

    constructor(dimensions = 32) {
        if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
            throw new EmbeddingError(
                "invalid-input",
                "Fake embedding dimensions must be a positive safe integer",
            );
        }

        this.identity = {
            provider: "deterministic-fake",
            model: "sha256-v1",
            dimensions,
            metric: "cosine",
        };
    }

    async embed(
        inputs: readonly EmbeddingInput[],
        options: EmbeddingProviderOptions = {},
    ): Promise<readonly EmbeddingResult[]> {
        if (options.signal?.aborted === true) {
            throw new EmbeddingError(
                "cancelled",
                "Fake embedding operation was cancelled",
                {},
                options.signal.reason,
            );
        }

        return inputs.map((input) => ({
            id: input.id,
            vector: deterministicVector(
                `${input.mode}\0${input.text}`,
                this.identity.dimensions,
            ),
        }));
    }
}

function deterministicVector(content: string, dimensions: number): Float32Array {
    const vector = new Float32Array(dimensions);

    for (let index = 0; index < dimensions; index += 1) {
        const digest = createHash("sha256")
            .update(content, "utf8")
            .update(`\0${index}`)
            .digest();
        vector[index] = digest.readInt32BE(0) / 0x8000_0000;
    }

    const magnitude = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0),
    );

    if (magnitude > 0) {
        for (let index = 0; index < vector.length; index += 1) {
            const value = vector[index];

            if (value !== undefined) {
                vector[index] = value / magnitude;
            }
        }
    }

    return vector;
}
