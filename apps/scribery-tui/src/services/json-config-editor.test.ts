import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
    editJsonConfiguration,
    parseEditorCommand,
    resolveTerminalEditor,
} from "./json-config-editor.js";

describe("JSON configuration editor", () => {
    it("resolves VISUAL arguments and falls back from missing editors", async () => {
        assert.deepEqual(parseEditorCommand('code --wait "--reuse window"'), {
            command: "code",
            arguments: ["--wait", "--reuse window"],
        });
        assert.deepEqual(await resolveTerminalEditor({
            env: { VISUAL: "missing --flag", EDITOR: "micro -softwrap off" },
            isExecutable: (command) => command === "micro",
        }), {
            command: "micro",
            arguments: ["-softwrap", "off"],
        });
        assert.deepEqual(await resolveTerminalEditor({
            env: {},
            isExecutable: (command) => command === "nano",
        }), {
            command: "nano",
            arguments: [],
        });
    });

    it("returns validated JSON changes and brackets the editor process", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-editor-test-"));
        const events: string[] = [];
        try {
            const edited = await editJsonConfiguration(
                { name: "local", count: 1 },
                "profile-local",
                {
                    env: {},
                    temporaryRoot: directory,
                    isExecutable: (command) => command === "micro",
                    beforeSpawn: () => events.push("before"),
                    afterSpawn: () => events.push("after"),
                    spawn: (_command, arguments_) => {
                        const path = arguments_.at(-1)!;
                        events.push("spawn");
                        const current = JSON.parse(
                            requireText(path),
                        ) as { name: string; count: number };
                        writeText(path, { ...current, count: 2 });
                        return { status: 0 };
                    },
                },
            );

            assert.deepEqual(edited, { name: "local", count: 2 });
            assert.deepEqual(events, ["before", "spawn", "after"]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("rejects malformed JSON after restoring the terminal", async () => {
        const directory = await mkdtemp(join(tmpdir(), "scribery-editor-test-"));
        let restored = false;
        try {
            await assert.rejects(editJsonConfiguration(
                { name: "local" },
                "profile-local",
                {
                    env: {},
                    temporaryRoot: directory,
                    isExecutable: () => true,
                    afterSpawn: () => { restored = true; },
                    spawn: (_command, arguments_) => {
                        writeRaw(arguments_.at(-1)!, "{");
                        return { status: 0 };
                    },
                },
            ), /not valid JSON/u);
            assert.equal(restored, true);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

function requireText(path: string): string {
    return readFileSync(path, "utf8");
}

function writeText(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeRaw(path: string, value: string): void {
    writeFileSync(path, value, "utf8");
}
