import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlidingWindowChunkingStrategy } from "../index.js";

describe("SlidingWindowChunkingStrategy", () => {
    it("creates deterministic overlapping text windows on source boundaries", async () => {
        const content = [
            "First paragraph contains Cyrillic: Привет 😀.",
            "",
            "Second paragraph contains enough text to require another window.",
            "",
            "Third paragraph finishes the document.",
        ].join("\n");
        const strategy = new SlidingWindowChunkingStrategy({ overlapSize: 12 });
        const chunks = await strategy.chunk({
            path: "notes/example.txt",
            content,
            language: "text",
            format: "plain-text",
        }, {
            maximumSize: 60,
            sizeUnit: "utf16-code-units",
        });

        assert.ok(chunks.length > 1);
        assert.equal(chunks[0]?.range.startOffset, 0);
        assert.equal(chunks.at(-1)?.range.endOffset, content.length);
        assert.ok(chunks.every(({ content: chunk, range, strategy: id, kind }) => {
            return chunk === content.slice(range.startOffset, range.endOffset) &&
                chunk.length <= 60 &&
                id === "sliding-window" &&
                kind === "text-window";
        }));
        assert.ok(chunks.slice(1).every((chunk, index) =>
            chunk.range.startOffset < chunks[index]!.range.endOffset
        ));
    });

    it("rejects overlap that cannot advance the window", async () => {
        await assert.rejects(
            new SlidingWindowChunkingStrategy({ overlapSize: 10 }).chunk({
                path: "notes.txt",
                content: "content",
                language: "text",
            }, {
                maximumSize: 10,
                sizeUnit: "utf16-code-units",
            }),
            /options are invalid/u,
        );
    });

    it("keeps a surrogate pair intact when it exceeds a one-unit window", async () => {
        const chunks = await new SlidingWindowChunkingStrategy({ overlapSize: 0 })
            .chunk({
                path: "emoji.txt",
                content: "😀x",
                language: "text",
            }, {
                maximumSize: 1,
                sizeUnit: "utf16-code-units",
            });

        assert.equal(chunks[0]?.content, "😀");
        assert.equal(chunks[0]?.range.endOffset, 2);
        assert.equal(chunks[1]?.content, "x");
    });
});
