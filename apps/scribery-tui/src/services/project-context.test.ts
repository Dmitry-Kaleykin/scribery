import assert from "node:assert/strict";
import test from "node:test";

import type { IndexedProjectSummary } from "scribery";

import { projectForDirectory } from "./project-context.js";

function project(root: string, projectIdentifier: string): IndexedProjectSummary {
    return {
        root,
        projectIdentifier,
        databasePath: `${root}/index.sqlite`,
        databaseBytes: 0,
        buildCount: 0,
        buildsByStatus: { building: 0, ready: 0, failed: 0, cancelled: 0 },
    };
}

test("selects the nearest indexed parent", () => {
    const selected = projectForDirectory(
        [project("/work", "outer"), project("/work/nested", "inner")],
        "/work/nested/src",
    );
    assert.equal(selected?.projectIdentifier, "inner");
});

test("does not select a path-prefix sibling", () => {
    const selected = projectForDirectory(
        [project("/work/app", "app")],
        "/work/application",
    );
    assert.equal(selected, undefined);
});
