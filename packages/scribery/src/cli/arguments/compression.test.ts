import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "node:util";
import { compressionFlags, compressionFromFlags } from "./compression.js";

describe("compression CLI settings", () => {
    it("overrides only selected profile values and preserves independent endpoints", () => {
        const parsed = parseArgs({ args: ["--compression-model", "Qwen3.5-4B", "--compression"], options: compressionFlags });
        const result = compressionFromFlags(parsed.values, {
            enabled: false, model: "Qwen3.5-2B", baseUrl: "http://localhost:8000/v1", timeoutMs: 1234,
        }, "http://localhost:1234/v1");
        assert.deepEqual(result, { enabled: true, model: "Qwen3.5-4B", baseUrl: "http://localhost:8000/v1", timeoutMs: 1234 });
    });
    it("supports opt-out, endpoint inheritance, and strict bounded numeric flags", () => {
        const parsed = parseArgs({ args: ["--no-compression", "--compression-timeout", "1000"], options: compressionFlags });
        assert.deepEqual(compressionFromFlags(parsed.values, {}, "http://localhost:8000/v1"), {
            enabled: false, timeoutMs: 1000, baseUrl: "http://localhost:8000/v1",
        });
        assert.throws(() => compressionFromFlags({ "compression-timeout": "30001" }), /timeoutMs/u);
        assert.throws(() => compressionFromFlags({ "compression-files": "NaN" }), /integer/u);
        assert.throws(() => compressionFromFlags({ compression: true, "no-compression": true }), /cannot be combined/u);
    });
});
