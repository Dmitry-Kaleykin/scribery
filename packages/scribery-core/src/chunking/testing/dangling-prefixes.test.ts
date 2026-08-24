import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SourceFragment } from "../strategies/cast/contracts/fragment.js";
import { compactDanglingPrefixes } from "../strategies/cast/utils/dangling-prefixes.js";

describe("compactDanglingPrefixes", () => {
    it("merges a small continuation prefix forward", () => {
        const prefix = "describe(\"suite\",";
        const continuation = " () => {\n    body();\n});";
        const content = `${prefix}${continuation}`;
        const fragments = compactDanglingPrefixes(
            [
                fragment(0, prefix.length),
                fragment(prefix.length, content.length),
            ],
            content,
            100,
            "src/example.ts",
        );

        assert.deepEqual(fragments, [fragment(0, content.length)]);
    });

    it("does not merge complete short constructs", () => {
        const first = "return value;\n";
        const content = `${first}next();\n`;
        const fragments = [
            fragment(0, first.length),
            fragment(first.length, content.length),
        ];

        assert.deepEqual(
            compactDanglingPrefixes(
                fragments,
                content,
                100,
                "src/example.ts",
            ),
            fragments,
        );
    });

    it("does not merge a large prefix or exceed the maximum size", () => {
        const largePrefix = `${"argument".repeat(4)},`;
        const largePrefixContent = `${largePrefix}continuation`;
        const oversizedContinuation = "x".repeat(98);
        const oversizedContent = `call(${oversizedContinuation}`;

        assert.deepEqual(
            compactDanglingPrefixes(
                [
                    fragment(0, largePrefix.length),
                    fragment(largePrefix.length, largePrefixContent.length),
                ],
                largePrefixContent,
                100,
                "src/example.ts",
            ),
            [
                fragment(0, largePrefix.length),
                fragment(largePrefix.length, largePrefixContent.length),
            ],
        );
        assert.deepEqual(
            compactDanglingPrefixes(
                [
                    fragment(0, "call(".length),
                    fragment("call(".length, oversizedContent.length),
                ],
                oversizedContent,
                100,
                "src/example.ts",
            ),
            [
                fragment(0, "call(".length),
                fragment("call(".length, oversizedContent.length),
            ],
        );
    });
});

function fragment(startOffset: number, endOffset: number): SourceFragment {
    return { startOffset, endOffset };
}
