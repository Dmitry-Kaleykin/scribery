import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveEmbeddingDimensionsInput } from "./embedding-dimensions.js";

describe("embedding dimensions input", () => {
    it("resolves auto case-insensitively to the inspected model width", () => {
        assert.equal(resolveEmbeddingDimensionsInput("auto", 1_024), 1_024);
        assert.equal(resolveEmbeddingDimensionsInput(" AUTO ", 768), 768);
    });

    it("still accepts an explicit positive integer", () => {
        assert.equal(resolveEmbeddingDimensionsInput("2560", 1_024), 2_560);
    });

    it("rejects empty, invalid, and unsafe values", () => {
        for (const value of ["", "automatic", "0", "-1", "1.5"]) {
            assert.throws(
                () => resolveEmbeddingDimensionsInput(value, 1_024),
                /must be auto or a positive integer/u,
            );
        }

        assert.throws(
            () => resolveEmbeddingDimensionsInput("auto", 0),
            /Detected embedding dimensions must be a positive integer/u,
        );
    });
});
