import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EmbeddingModelIdentity } from "../../metadata/index.js";
import { createArtifactCompatibilityHash } from "../index.js";

const model: EmbeddingModelIdentity = {
    provider: "fixture",
    model: "fixture-v1",
    dimensions: 3,
    metric: "cosine",
};

describe("artifact compatibility identity", () => {
    it("is canonical across parser and chunking identity order", () => {
        const first = createArtifactCompatibilityHash({
            chunkingIdentities: ["sliding-v1:100:20", "cast-v1:100"],
            parserIdentities: ["parser-b", "parser-a"],
            modelIdentity: model,
        });
        const reordered = createArtifactCompatibilityHash({
            chunkingIdentities: ["cast-v1:100", "sliding-v1:100:20"],
            parserIdentities: ["parser-a", "parser-b"],
            modelIdentity: {
                metric: model.metric,
                dimensions: model.dimensions,
                model: model.model,
                provider: model.provider,
            },
        });

        assert.equal(first, reordered);
    });

    it("changes with an artifact-producing identity", () => {
        const baseline = createArtifactCompatibilityHash({
            chunkingIdentities: ["cast-v1:100"],
            parserIdentities: ["parser-v1"],
            modelIdentity: model,
        });

        assert.notEqual(baseline, createArtifactCompatibilityHash({
            chunkingIdentities: ["cast-v1:101"],
            parserIdentities: ["parser-v1"],
            modelIdentity: model,
        }));
        assert.notEqual(baseline, createArtifactCompatibilityHash({
            chunkingIdentities: ["cast-v1:100"],
            parserIdentities: ["parser-v2"],
            modelIdentity: model,
        }));
        assert.notEqual(baseline, createArtifactCompatibilityHash({
            chunkingIdentities: ["cast-v1:100"],
            parserIdentities: ["parser-v1"],
            modelIdentity: { ...model, model: "fixture-v2" },
        }));
    });
});
