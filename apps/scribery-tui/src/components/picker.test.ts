import assert from "node:assert/strict";
import test from "node:test";

import { Picker } from "./picker.js";

test("Ctrl+D requests deletion of the selected picker item", () => {
    let deleted: string | undefined;
    const picker = new Picker({
        title: "Build history",
        items: [
            { value: "build-1", label: "Build 1" },
            { value: "build-2", label: "Build 2" },
        ],
        onSelect: () => undefined,
        onDelete: (item) => {
            deleted = item.value;
        },
        onCancel: () => undefined,
        requestRender: () => undefined,
    });
    picker.focused = true;
    picker.handleInput("\u001b[B");
    picker.handleInput("\u0004");

    assert.equal(deleted, "build-2");
    assert.match(picker.render(100).join("\n"), /Ctrl\+D delete/u);
});

test("editable pickers accept a typed target even when suggestions still match", () => {
    let selected: string | undefined;
    const picker = new Picker({
        title: "Select or enter indexing target",
        items: [{ value: "release/stable", label: "release/stable" }],
        allowCustomValue: true,
        onSelect: (item) => { selected = item.value; },
        onCancel() {}, requestRender() {},
    });
    for (const character of "release") picker.handleInput(character);
    assert.match(picker.render(100).join("\n"), /Use "release"/);
    picker.handleInput("\r");
    assert.equal(selected, "release");
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");
    assert.equal(selected, "release/stable");
});

test("editable pickers accept a new name with no suggestions and allow cancellation", () => {
    let selected: string | undefined;
    let cancelled = false;
    const picker = new Picker({
        title: "Select or enter indexing target", items: [], allowCustomValue: true,
        onSelect: (item) => { selected = item.value; },
        onCancel: () => { cancelled = true; }, requestRender() {},
    });
    picker.handleInput("\r");
    assert.equal(selected, undefined);
    for (const character of "snapshot/new") picker.handleInput(character);
    picker.handleInput("\r");
    assert.equal(selected, "snapshot/new");
    picker.handleInput("\u001b");
    assert.equal(cancelled, true);
});
