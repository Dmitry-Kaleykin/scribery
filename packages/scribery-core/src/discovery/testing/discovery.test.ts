import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DefaultFileDiscovery } from "../index.js";

describe("DefaultFileDiscovery", () => {
    it("streams deterministic files with ignore and symlink diagnostics", async () => {
        const root = await mkdtemp(join(tmpdir(), "scribery-discovery-"));
        await mkdir(join(root, "src"));
        await mkdir(join(root, "ignored"));
        await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
        await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");
        await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
        await writeFile(join(root, "ignored", "hidden.ts"), "ignored\n");
        await writeFile(join(root, "debug.log"), "ignored\n");
        await symlink(join(root, "src", "a.ts"), join(root, "link.ts"));
        const events = [];

        for await (const event of new DefaultFileDiscovery().discover(root, {
            include: ["**/*.ts"],
        })) {
            events.push(event);
        }

        assert.deepEqual(
            events.filter(({ type }) => type === "file").map((event) =>
                event.type === "file" ? event.file.relativePath : ""
            ),
            ["src/a.ts", "src/b.ts"],
        );
        assert.ok(events.some((event) =>
            event.type === "diagnostic" &&
            event.diagnostic.code === "symbolic-link-skipped"
        ));
    });
});
