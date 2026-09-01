import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

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

test("prompt descriptions explain an input without exceeding the viewport", () => {
    const prompt = new TextPrompt({
        title: "Add directory",
        label: "Source namespace",
        description:
            "A unique path prefix that keeps files from different sources " +
            "from colliding within this documentation.",
        onSubmit: () => undefined,
        onCancel: () => undefined,
        requestRender: () => undefined,
    });

    const lines = prompt.render(48);
    const rendered = lines.join("\n");
    assert.match(rendered, /unique path prefix/u);
    assert.match(rendered, /different sources/u);
    assert.match(rendered, /documentation\./u);
    assert.ok(lines.every((line) => visibleWidth(line) <= 48));
});
