import assert from "node:assert/strict";
import test from "node:test";

import { FooterComponent, formatLocation } from "./footer.js";

test("shows the active project and a project-relative current directory", () => {
    assert.equal(formatLocation(
        "/Users/test/Projects/scribery/src/storage",
        "/Users/test/Projects/scribery",
        "/Users/test",
    ), "~/Projects/scribery · cwd: src/storage");
});

test("shows a dot when launched at the active project root", () => {
    assert.equal(formatLocation(
        "/Users/test/Projects/scribery",
        "/Users/test/Projects/scribery",
        "/Users/test",
    ), "~/Projects/scribery · cwd: .");
});

test("shows the actual cwd when a different project is selected", () => {
    assert.equal(formatLocation(
        "/Users/test/Projects/notes",
        "/Users/test/Projects/scribery",
        "/Users/test",
    ), "cwd: ~/Projects/notes");
});

test("keeps the location first when a narrow terminal truncates the footer", () => {
    const footer = new FooterComponent();
    footer.setLocation("/tmp/scribery/src", "/tmp/scribery");

    const [line = ""] = footer.render(25);
    const plain = line.replace(/\u001b\[[0-9;]*m/gu, "");

    assert.match(plain, /\/tmp\/scribery/u);
    assert.doesNotMatch(plain, /Ctrl\+C twice exits/u);
});
