import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Chunk } from "../../chunking/index.js";
import { selectSearchableChunks } from "../index.js";

describe("selectSearchableChunks", () => {
    it("removes whitespace-only chunks without trimming meaningful content", () => {
        const chunks: readonly Chunk[] = [
            chunk("\n\n", 0, 2),
            chunk("\n\tconst answer = 42;\n", 2, 23),
            chunk(" \t\r\n", 23, 27),
            {
                ...chunk("</wrapper>", 27, 37),
                searchable: false,
            },
        ];

        const selected = selectSearchableChunks(chunks);

        assert.equal(selected.length, 1);
        assert.equal(selected[0], chunks[1]);
        assert.equal(selected[0]?.content, "\n\tconst answer = 42;\n");
    });
});

function chunk(
    content: string,
    startOffset: number,
    endOffset: number,
): Chunk {
    return {
        content,
        range: {
            startOffset,
            endOffset,
            startLine: 1,
            endLine: 1,
        },
        strategy: "cast",
    };
}
