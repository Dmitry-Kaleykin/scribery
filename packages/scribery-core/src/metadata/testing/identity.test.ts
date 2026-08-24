import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    MetadataError,
    createEmbeddingId,
    createEmbeddingInputId,
    createIdentity,
    createRepositoryId,
    hashBytes,
    hashText,
    normalizeRelativePath,
    type EmbeddingModelIdentity,
} from "../index.js";

describe("metadata identities", () => {
    it("creates deterministic namespaced identities and content hashes", () => {
        assert.equal(createRepositoryId("example"), createRepositoryId("example"));
        assert.notEqual(createRepositoryId("example"), createRepositoryId("other"));
        assert.notEqual(
            createEmbeddingInputId("document-a", "shared-chunk"),
            createEmbeddingInputId("document-b", "shared-chunk"),
        );
        assert.notEqual(
            createIdentity("test", ["a", "bc"]),
            createIdentity("test", ["ab", "c"]),
        );
        assert.match(hashText("Привет 😀"), /^sha256:[a-f0-9]{64}$/u);
        assert.equal(
            hashBytes(new TextEncoder().encode("same")),
            hashText("same"),
        );
    });

    it("normalizes portable paths and rejects root escapes", () => {
        assert.equal(normalizeRelativePath("src\\nested/./file.ts"), "src/nested/file.ts");
        assert.throws(
            () => normalizeRelativePath("../secret.ts"),
            (error: unknown) => error instanceof MetadataError && error.code === "invalid-path",
        );
        assert.throws(() => normalizeRelativePath("/absolute.ts"), MetadataError);
    });

    it("includes the embedding suffix in vector identity", () => {
        const model: EmbeddingModelIdentity = {
            provider: "fixture",
            model: "embedding-v1",
            dimensions: 4,
            metric: "cosine",
        };
        const withoutSuffix = createEmbeddingId("input", model);
        const withSuffix = createEmbeddingId("input", {
            ...model,
            embeddingSuffix: "<|endoftext|>",
        });

        assert.notEqual(withoutSuffix, withSuffix);
    });
});
