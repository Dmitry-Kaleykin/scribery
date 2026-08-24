import assert from "node:assert/strict";
import test from "node:test";

import { shouldRenderIndexingProgressImmediately } from "./indexing-render-policy.js";

test("renders indexing phase transitions immediately", () => {
    assert.equal(shouldRenderIndexingProgressImmediately(
        { phase: "discovery", completed: 20 },
        { phase: "processing", completed: 0, total: 20 },
    ), true);
});

test("renders each newly chunked path immediately", () => {
    assert.equal(shouldRenderIndexingProgressImmediately(
        {
            phase: "processing",
            activity: "chunking",
            currentPath: "src/first.ts",
            completed: 1,
            total: 20,
        },
        {
            phase: "processing",
            activity: "chunking",
            currentPath: "src/second.ts",
            completed: 1,
            total: 20,
        },
    ), true);
});

test("leaves ordinary same-phase counter updates throttled", () => {
    assert.equal(shouldRenderIndexingProgressImmediately(
        { phase: "embedding", completed: 10, total: 20 },
        { phase: "embedding", completed: 11, total: 20 },
    ), false);
});
