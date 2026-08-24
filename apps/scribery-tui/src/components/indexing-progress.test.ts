import assert from "node:assert/strict";
import test from "node:test";

import { IndexingProgressComponent } from "./indexing-progress.js";

test("replaces the current path instead of retaining earlier files", () => {
    const component = new IndexingProgressComponent();
    component.setState({
        stage: "indexing",
        progress: { phase: "processing", completed: 1, total: 2, currentPath: "src/first.ts" },
    });
    assert.match(component.render(80).join("\n"), /first\.ts/u);

    component.setState({
        stage: "indexing",
        progress: { phase: "processing", completed: 2, total: 2, currentPath: "src/second.ts" },
    });
    const rendered = component.render(80).join("\n");
    assert.match(rendered, /second\.ts/u);
    assert.doesNotMatch(rendered, /first\.ts/u);
});

test("never renders wider than the viewport", () => {
    const component = new IndexingProgressComponent();
    component.setState({
        stage: "indexing",
        progress: {
            phase: "processing",
            completed: 25,
            total: 100,
            currentPath: "a/very/long/path/to/a/currently/processed/source/file.ts",
        },
    });
    for (const line of component.render(36)) {
        const plain = line.replace(/\u001b\[[0-9;]*m/gu, "");
        assert.ok(plain.length <= 36, `${plain.length}: ${plain}`);
    }
});
