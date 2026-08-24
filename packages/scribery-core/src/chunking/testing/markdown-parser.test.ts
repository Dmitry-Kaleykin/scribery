import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    CastChunkingStrategy,
    createInitialParserRegistry,
} from "../index.js";
import type {
    ChunkingDocument,
    SyntaxNode,
} from "../index.js";

function findNode(root: SyntaxNode, type: string): SyntaxNode | undefined {
    const pending = [root];

    while (pending.length > 0) {
        const node = pending.pop();

        if (node === undefined) {
            break;
        }

        if (node.type === type) {
            return node;
        }

        pending.push(...node.children);
    }

    return undefined;
}

describe("Markdown parser", () => {
    it("registers Markdown and normalizes GFM structure", async () => {
        const registry = createInitialParserRegistry();
        const content = [
            "# Scribery",
            "",
            "Local retrieval for source projects.",
            "",
            "## Capabilities",
            "",
            "- [x] Structural chunking",
            "- [ ] Lexical retrieval",
            "",
            "| Format | Parser |",
            "| --- | --- |",
            "| TypeScript | cAST |",
            "",
        ].join("\n");
        const tree = await registry.parse({
            path: "README.md",
            language: "markdown",
            format: "markdown",
            content,
        });

        assert.equal(registry.canParse({
            language: "markdown",
            format: "markdown",
        }), true);
        assert.equal(tree.parserId, "mdast-gfm-v1");
        assert.equal(tree.root.type, "markdown:document");
        assert.equal(tree.root.range.endOffset, content.length);
        assert.ok(findNode(tree.root, "markdown:section:1"));
        assert.ok(findNode(tree.root, "markdown:section:2"));
        assert.ok(findNode(tree.root, "markdown:list"));
        assert.ok(findNode(tree.root, "markdown:table"));
    });

    it("keeps headings with their section content and reconstructs the source", async () => {
        const document: ChunkingDocument = {
            path: "docs/configuration.md",
            language: "markdown",
            format: "markdown",
            content: [
                "# Configuration",
                "",
                "Profiles keep model settings reusable across commands.",
                "",
                "## Indexing",
                "",
                "Run `scribery index` after changing saved project files.",
                "",
            ].join("\n"),
        };
        const chunks = await new CastChunkingStrategy(
            createInitialParserRegistry(),
        ).chunk(document, {
            maximumSize: 90,
            sizeUnit: "utf16-code-units",
        });

        assert.equal(
            chunks.map(({ content }) => content).join(""),
            document.content,
        );
        assert.ok(chunks.every(({ content }) => content.trim().length > 0));
        assert.ok(chunks.some(({ content }) =>
            content.startsWith("# Configuration\n\nProfiles keep")
        ));
        assert.ok(chunks.every(({ content }) =>
            content.trim() !== "# Configuration" &&
            content.trim() !== "## Indexing"
        ));
    });

    it("exposes line boundaries inside multiline fenced code", async () => {
        const content = [
            "# Example",
            "",
            "```ts",
            ...Array.from(
                { length: 12 },
                (_, index) => `const value${index} = ${index};`,
            ),
            "```",
            "",
        ].join("\n");
        const chunks = await new CastChunkingStrategy(
            createInitialParserRegistry(),
        ).chunk({
            path: "docs/example.md",
            language: "markdown",
            format: "markdown",
            content,
        }, {
            maximumSize: 80,
            sizeUnit: "utf16-code-units",
        });

        assert.equal(chunks.map(({ content }) => content).join(""), content);
        assert.ok(chunks.length > 1);
        assert.ok(chunks.every(({ content }) => content.length <= 80));
    });
});
