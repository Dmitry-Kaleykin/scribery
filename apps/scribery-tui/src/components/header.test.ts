import assert from "node:assert/strict";
import test from "node:test";

import { HeaderComponent } from "./header.js";

test("shows the live branch target and freshness phase", () => {
    const header = new HeaderComponent();
    const now = new Date().toISOString();
    header.setState({
        indexing: false,
        live: {
            schemaVersion: 1,
            sessionId: "test-session",
            processId: process.pid,
            projectIdentifier: "0123456789abcdef01234567",
            root: "/tmp/project",
            phase: "pending",
            generation: 2,
            startedAt: now,
            updatedAt: now,
            branch: "task123",
            target: "live/task123",
        },
    });

    const plain = header.render(160)
        .join("\n")
        .replace(/\u001b\[[0-9;]*m/gu, "");
    assert.match(plain, /Status live pending/u);
    assert.match(plain, /live\/task123/u);
});
