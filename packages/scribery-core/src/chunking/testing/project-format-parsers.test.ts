import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    CastChunkingStrategy,
    ChunkingError,
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

describe("project format parsers", () => {
    it("registers project format targets", () => {
        const registry = createInitialParserRegistry();

        for (const target of [
            { language: "html", format: "html" },
            { language: "json", format: "json" },
            { language: "vue", format: "vue" },
            { language: "twig", format: "twig" },
            { language: "css", format: "css" },
            { language: "scss", format: "scss" },
            { language: "markdown", format: "markdown" },
        ]) {
            assert.equal(registry.canParse(target), true);
        }
    });

    it("normalizes location-aware HTML nodes", async () => {
        const document: ChunkingDocument = {
            path: "public/index.html",
            language: "html",
            format: "html",
            content: "<!doctype html>\r\n<main><h1>Привет 😀</h1></main>\r\n",
        };
        const tree = await createInitialParserRegistry().parse(document);

        assert.equal(tree.root.type, "html_document");
        assert.ok(findNode(tree.root, "doctype"));
        assert.ok(findNode(tree.root, "element:main"));
        assert.ok(findNode(tree.root, "element:h1"));
        assert.equal(tree.root.range.endOffset, document.content.length);
    });

    it("parses strict JSON with structural object and array nodes", async () => {
        const tree = await createInitialParserRegistry().parse({
            path: "config/data.json",
            language: "json",
            format: "json",
            content: "{\"title\":\"Привет 😀\",\"items\":[1,true,null]}\n",
        });

        assert.equal(tree.parserId, "typescript-json-v2");
        assert.ok(findNode(tree.root, "ObjectLiteralExpression"));
        assert.ok(findNode(tree.root, "PropertyAssignment"));
        assert.ok(findNode(tree.root, "ArrayLiteralExpression"));
    });

    it("embeds TypeScript structure inside Vue components", async () => {
        const tree = await createInitialParserRegistry().parse({
            path: "src/App.vue",
            language: "vue",
            format: "vue",
            content: [
                "<template><main>{{ title }}</main></template>",
                "<script setup lang=\"ts\">",
                "const title: string = \"Hello\";",
                "</script>",
                "",
            ].join("\n"),
        });

        assert.ok(findNode(tree.root, "element:template"));
        assert.ok(findNode(tree.root, "element:script"));
        assert.ok(findNode(tree.root, "embedded:typescript"));
        assert.ok(findNode(tree.root, "VariableStatement"));
    });

    it("compacts Vue wrapper boundaries into meaningful chunks", async () => {
        const document: ChunkingDocument = {
            path: "src/App.vue",
            language: "vue",
            format: "vue",
            content: [
                "<template>",
                `    <main>${"Hello ".repeat(20)}</main>`,
                "</template>",
                "",
                "<script setup lang=\"ts\">",
                ...Array.from(
                    { length: 8 },
                    (_, index) => `const value${index}: number = ${index};`,
                ),
                "</script>",
                "",
                "<style scoped>",
                ...Array.from(
                    { length: 8 },
                    (_, index) => `.item-${index} { color: red; }`,
                ),
                "</style>",
                "",
            ].join("\n"),
        };
        const chunks = await new CastChunkingStrategy(
            createInitialParserRegistry(),
        ).chunk(document, {
            maximumSize: 80,
            sizeUnit: "utf16-code-units",
        });

        assert.equal(
            chunks.map(({ content }) => content).join(""),
            document.content,
        );
        const searchableChunks = chunks.filter(
            ({ searchable }) => searchable !== false,
        );

        assert.ok(searchableChunks.every(({ content }) => content.length <= 80));
        assert.ok(searchableChunks.every(({ content }) =>
            ![
                "<template>",
                "</template>",
                "<script setup lang=\"ts\">",
                "</script>",
                "<style scoped>",
                "</style>",
            ].includes(content.trim())
        ));
        assert.ok(searchableChunks[0]?.content.startsWith("<main>"));
        assert.ok(chunks.some(({ content, searchable }) =>
            searchable === false && content.includes("<template>")
        ));
        assert.ok(chunks.some(({ content }) =>
            content.includes("</template>")
        ));
    });

    it("retains HTML and Twig delimiter structure", async () => {
        const tree = await createInitialParserRegistry().parse({
            path: "templates/page.html.twig",
            language: "twig",
            format: "twig",
            content: "<main>{% if title %}<h1>{{ title }}</h1>{% endif %}</main>\n",
        });

        assert.ok(findNode(tree.root, "element:main"));
        assert.ok(findNode(tree.root, "twig_tag:if"));
        assert.ok(findNode(tree.root, "twig_output"));
        assert.ok(findNode(tree.root, "twig_tag:endif"));
    });

    it("recovers from HTML diagnostics caused by template syntax", async () => {
        const documents: readonly ChunkingDocument[] = [
            {
                path: "App.vue",
                language: "vue",
                format: "vue",
                content: [
                    "<template>",
                    "<p><section>{{ title }}</section></p>",
                    "</template>",
                    "<script>const title = 'Hello';</script>",
                ].join("\n"),
            },
            {
                path: "report.twig",
                language: "twig",
                format: "twig",
                content: [
                    "<div><table>",
                    "{% for row in rows %}",
                    "<tr><td><a href='{{ '/reports/?id=' ~ row.id }}'>{{ row.title }}</a></td></tr>",
                    "{% endfor %}",
                    "</table></div>",
                ].join("\n"),
            },
        ];
        const strategy = new CastChunkingStrategy(
            createInitialParserRegistry(),
        );

        for (const document of documents) {
            const chunks = await strategy.chunk(document, {
                maximumSize: 30,
                sizeUnit: "utf16-code-units",
            });

            assert.ok(chunks.length > 0);
            assert.equal(
                chunks.map(({ content }) => content).join(""),
                document.content,
            );
        }
    });

    it("rejects malformed HTML, JSON, Vue scripts, and Twig delimiters", async () => {
        const malformed: readonly ChunkingDocument[] = [
            {
                path: "page.html",
                language: "html",
                format: "html",
                content: "<main data-value=broken\"value></main>",
            },
            {
                path: "data.json",
                language: "json",
                format: "json",
                content: "{\"value\": ]}",
            },
            {
                path: "App.vue",
                language: "vue",
                format: "vue",
                content: "<script lang=\"ts\">const value: = 1;</script>",
            },
            {
                path: "page.twig",
                language: "twig",
                format: "twig",
                content: "<main>{{ value</main>",
            },
        ];

        for (const document of malformed) {
            await assert.rejects(
                createInitialParserRegistry().parse(document),
                (error: unknown) => {
                    assert.ok(error instanceof ChunkingError);
                    assert.equal(error.code, "parser-failure");
                    return true;
                },
            );
        }
    });

    it("reconstructs every project format exactly after cAST chunking", async () => {
        const documents: readonly ChunkingDocument[] = [
            {
                path: "index.html",
                language: "html",
                format: "html",
                content: "<main><section>First</section><section>Second</section></main>\n",
            },
            {
                path: "data.json",
                language: "json",
                format: "json",
                content: "{\"first\":[1,2,3],\"second\":[4,5,6]}\n",
            },
            {
                path: "App.vue",
                language: "vue",
                format: "vue",
                content: "<template><main>Hello</main></template>\n<script>const value = 1;</script>\n",
            },
            {
                path: "page.twig",
                language: "twig",
                format: "twig",
                content: "<main>{% if value %}{{ value }}{% endif %}</main>\n",
            },
            {
                path: "app.css",
                language: "css",
                format: "css",
                content: ".first { color: red; }\n.second { color: blue; }\n",
            },
            {
                path: "theme.scss",
                language: "scss",
                format: "scss",
                content: "$brand: blue;\n.first { color: $brand; }\n",
            },
        ];
        const strategy = new CastChunkingStrategy(
            createInitialParserRegistry(),
        );

        for (const document of documents) {
            const chunks = await strategy.chunk(document, {
                maximumSize: 30,
                sizeUnit: "utf16-code-units",
            });

            assert.equal(
                chunks.map(({ content }) => content).join(""),
                document.content,
            );
        }
    });
});
