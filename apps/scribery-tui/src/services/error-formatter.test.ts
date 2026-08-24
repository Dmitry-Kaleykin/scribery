import assert from "node:assert/strict";
import test from "node:test";

import { formatError } from "./error-formatter.js";

test("renders nested provider causes with codes and details", () => {
    const provider = Object.assign(
        new Error("OpenAI-compatible embeddings endpoint is unavailable", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
                code: "ECONNREFUSED",
            }),
        }),
        {
            code: "provider-unavailable",
            details: { baseUrl: "http://127.0.0.1:11434/v1" },
        },
    );
    const diagnostic = Object.assign(
        new Error("Embedding provider diagnostic failed", { cause: provider }),
        {
            code: "diagnostic-failed",
            details: { expectedDimensions: 1024 },
        },
    );

    const rendered = formatError(diagnostic);

    assert.match(rendered, /^Error: Embedding provider diagnostic failed/mu);
    assert.match(rendered, /Code: diagnostic-failed/u);
    assert.match(rendered, /expectedDimensions.*1024/u);
    assert.match(rendered, /Caused by: OpenAI-compatible embeddings endpoint is unavailable/u);
    assert.match(rendered, /baseUrl.*11434/u);
    assert.match(rendered, /Caused by: connect ECONNREFUSED/u);
    assert.match(rendered, /Code: ECONNREFUSED/u);
});

test("renders non-Error failures", () => {
    assert.equal(formatError("provider failed"), "Error: provider failed");
});
