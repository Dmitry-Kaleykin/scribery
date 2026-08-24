import assert from "node:assert/strict";
import { it } from "node:test";

import { EmbeddingError } from "scribery-core";
import { IndexingError } from "scribery-core";
import { serializeError } from "scribery-core";

it("serializes structured nested CLI failures", () => {
    const cause = new EmbeddingError(
        "invalid-provider-response",
        "Embedding vector dimensions do not match: expected 768, received 1024",
        { expectedDimensions: 768, actualDimensions: 1024 },
    );
    const failure = new IndexingError(
        "indexing-failed",
        "Index build failed",
        { indexBuildId: "build" },
        cause,
    );

    assert.deepEqual(serializeError(failure), {
        name: "IndexingError",
        code: "indexing-failed",
        message: "Index build failed",
        details: { indexBuildId: "build" },
        cause: {
            name: "EmbeddingError",
            code: "invalid-provider-response",
            message:
                "Embedding vector dimensions do not match: expected 768, received 1024",
            details: { expectedDimensions: 768, actualDimensions: 1024 },
        },
    });
});
