import assert from "node:assert/strict";
import test from "node:test";

import { TextPrompt } from "./text-prompt.js";

test("masked prompts never render their value and still submit it", () => {
    let submitted: string | undefined;
    const prompt = new TextPrompt({
        title: "API key",
        maskInput: true,
        onSubmit: (value) => {
            submitted = value;
        },
        onCancel: () => undefined,
        requestRender: () => undefined,
    });
    prompt.focused = true;
    prompt.handleInput("secret-value");

    const rendered = prompt.render(80).join("\n");
    assert.doesNotMatch(rendered, /secret-value/u);
    assert.match(rendered, /•{12}/u);

    prompt.handleInput("\r");
    assert.equal(submitted, "secret-value");
});
