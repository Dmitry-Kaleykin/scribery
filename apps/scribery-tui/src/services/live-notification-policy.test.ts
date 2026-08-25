import assert from "node:assert/strict";
import test from "node:test";

import { shouldAnnounceLiveReady } from "./live-notification-policy.js";

const taskBranch = {
    branch: "task123",
    target: "live/task123",
} as const;

test("announces the first live-ready build", () => {
    assert.equal(shouldAnnounceLiveReady(undefined, taskBranch, false), true);
});

test("keeps routine successful reconciliations out of the transcript", () => {
    assert.equal(shouldAnnounceLiveReady(taskBranch, taskBranch, false), false);
});

test("announces branch and target changes", () => {
    assert.equal(shouldAnnounceLiveReady(taskBranch, {
        branch: "task456",
        target: "live/task456",
    }, false), true);
    assert.equal(shouldAnnounceLiveReady(taskBranch, {
        branch: "task123",
        target: "live/replacement",
    }, false), true);
});

test("announces recovery after a live-indexing failure", () => {
    assert.equal(shouldAnnounceLiveReady(taskBranch, taskBranch, true), true);
});
