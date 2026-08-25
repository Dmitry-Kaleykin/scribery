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
