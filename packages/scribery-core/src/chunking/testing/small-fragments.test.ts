import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SourceFragment } from "../strategies/cast/contracts/fragment.js";
import { compactSmallFragments } from "../strategies/cast/utils/small-fragments.js";

describe("compactSmallFragments", () => {
    it("folds a small semantic fragment into the larger compatible neighbor", () => {
        const left = "L".repeat(10);
        const small = "setup";
        const right = "R".repeat(20);
        const content = `${left}${small}${right}`;

        assert.deepEqual(
            compactSmallFragments(
                [
                    fragment(0, left.length),
                    fragment(left.length, left.length + small.length),
                    fragment(left.length + small.length, content.length),
                ],
                content,
                30,
                "src/example.ts",
            ),
            [
                fragment(0, left.length),
                fragment(left.length, content.length),
            ],
        );
    });

    it("keeps trailing continuations with the preceding fragment", () => {
        const left = "L".repeat(20);
        const continuation = "catch";
        const right = "R".repeat(10);
        const content = `${left}${continuation}${right}`;

        assert.deepEqual(
            compactSmallFragments(
                [
                    fragment(0, left.length),
                    fragment(
                        left.length,
                        left.length + continuation.length,
                    ),
                    fragment(left.length + continuation.length, content.length),
                ],
                content,
                30,
                "src/example.ts",
            ),
            [
                fragment(0, left.length + continuation.length),
                fragment(left.length + continuation.length, content.length),
            ],
        );
    });

    it("does not merge when neither neighbor has room", () => {
        const left = "L".repeat(28);
        const small = "xx";
        const right = "R".repeat(28);
        const content = `${left}${small}${right}`;
        const fragments = [
            fragment(0, left.length),
            fragment(left.length, left.length + small.length),
            fragment(left.length + small.length, content.length),
        ];

        assert.deepEqual(
            compactSmallFragments(
                fragments,
                content,
                29,
                "src/example.ts",
            ),
            fragments,
        );
    });
});

function fragment(startOffset: number, endOffset: number): SourceFragment {
    return { startOffset, endOffset };
}
