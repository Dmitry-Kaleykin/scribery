import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    DOCUMENTS_PROCESSING_RUNTIME_IDENTITY,
    createDocumentsProcessingRuntime,
} from "../index.js";

describe("documents processing runtime", () => {
    it("composes cAST and sliding-window strategies", () => {
        const runtime = createDocumentsProcessingRuntime();

        assert.equal(
            runtime.identity,
            DOCUMENTS_PROCESSING_RUNTIME_IDENTITY,
        );
        assert.deepEqual(
            runtime.createChunkingStrategies({ slidingWindowOverlap: 20 })
                .map((strategy) => strategy.id),
            ["cast", "sliding-window"],
        );
        assert.ok(runtime.parserRegistry.parserIds().length > 0);
    });
});
