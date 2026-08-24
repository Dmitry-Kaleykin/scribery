import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    CODE_PROCESSING_RUNTIME_IDENTITY,
    createCodeProcessingRuntime,
} from "../index.js";

describe("code processing runtime", () => {
    it("composes only the cAST strategy", () => {
        const runtime = createCodeProcessingRuntime();

        assert.equal(runtime.identity, CODE_PROCESSING_RUNTIME_IDENTITY);
        assert.deepEqual(
            runtime.createChunkingStrategies({ slidingWindowOverlap: 20 })
                .map((strategy) => strategy.id),
            ["cast"],
        );
        assert.ok(runtime.parserRegistry.parserIds().length > 0);
    });
});
