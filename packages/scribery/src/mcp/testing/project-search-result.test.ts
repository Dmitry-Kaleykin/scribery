import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectSearchResult } from "scribery-code";
import {
    formatProjectSearchGuidance,
    formatProjectSearchResult,
    projectSearchFailure,
} from "../results/project-search-result.js";

describe("MCP project search result formatting", () => {
    it("presents paths, line ranges, context, and excerpts without storage metadata", () => {
        const result = fixture({
            resultCount: 1,
            results: [{
                score: 0.91,
                repositoryId: "repository-secret",
                snapshotId: "snapshot-secret",
                indexBuildId: "build-secret",
                documentId: "document-secret",
                chunkId: "chunk-secret",
                path: "src/auth/session.ts",
                language: "typescript",
                format: "code",
                content: "export function authenticate() {\n    return session.valid;\n}",
                range: {
                    startOffset: 120,
                    endOffset: 180,
                    startLine: 42,
                    endLine: 44,
                },
                semanticContext: {
                    scope: [{
                        name: "SessionService",
                        kind: "class",
                        signature: "export class SessionService",
                    }],
                    symbols: [{
                        name: "authenticate",
                        kind: "method",
                        signature: "authenticate(): boolean",
                    }],
                    imports: [{
                        source: "./session.js",
                        bindings: ["session"],
                    }],
                },
                context: {
                    before: [{
                        chunkId: "before",
                        index: 1,
                        content: "const session = readSession();",
                        range: {
                            startOffset: 90,
                            endOffset: 119,
                            startLine: 40,
                            endLine: 40,
                        },
                    }],
                    after: [{
                        chunkId: "after",
                        index: 3,
                        content: "// A markdown example uses ``` fences.",
                        range: {
                            startOffset: 181,
                            endOffset: 225,
                            startLine: 46,
                            endLine: 46,
                        },
                    }],
                },
            }],
        });

        const text = formatProjectSearchResult(result, "session refresh", 6);

        assert.match(text, /search_codebase found 1 match for "session refresh"\./u);
        assert.match(text, /### 1\. src\/auth\/session\.ts:42-44/u);
        assert.match(text, /Relevance: 0\.91/u);
        assert.match(text, /Returned: lines 40-46\./u);
        assert.match(text, /Scope: class SessionService/u);
        assert.match(text, /Defines: method authenticate\(\): boolean/u);
        assert.match(text, /Imports: session from \.\/session\.js/u);
        assert.match(text, /````typescript/u);
        assert.match(text, /const session = readSession\(\);/u);
        assert.match(text, /export function authenticate/u);
        assert.doesNotMatch(text, /Capped at/u);
        assert.doesNotMatch(
            text,
            /repository-secret|snapshot-secret|build-secret|document-secret/u,
        );
    });

    it("states the cap when every requested match was returned", () => {
        const capped = fixture({ resultCount: 1, results: [fixtureResult()] });

        assert.match(
            formatProjectSearchResult(capped, "session", 1),
            /Capped at 1 matches\. Pass a larger limit for more\./u,
        );
    });

    it("reports an empty result loudly and teaches a retry", () => {
        const text = formatProjectSearchResult(
            fixture({ resultCount: 0, results: [] }),
            "upload retry",
            6,
        );

        assert.match(text, /No matches for "upload retry" in \/project\./u);
        assert.match(text, /ran successfully[\s\S]*not a tool failure/u);
        assert.match(text, /Retry with different words:/u);
        assert.match(text, /describe the behavior instead of the name/u);
        assert.match(text, /search the working tree with your own text search/u);
    });

    it("keeps failures loud with a reason and the next command", () => {
        const failure = projectSearchFailure(
            new Error("Indexed project app has no ready build"),
        );

        assert.equal(failure.isError, true);
        assert.equal(failure.content.length, 2);
        const text = failure.content
            .map((block) => ("text" in block ? block.text : ""))
            .join("\n");

        assert.match(text, /Indexed project app has no ready build/u);
        assert.match(
            text,
            /this is not an empty result[\s\S]*Next: run `scribery reindex/iu,
        );
    });

    it("turns a failure into a reason and the next command", () => {
        assert.match(
            formatProjectSearchGuidance(
                new Error("No indexed projects are available"),
            ),
            /this is not an empty result[\s\S]*Next: run `scribery index <project-root>`/iu,
        );
        assert.match(
            formatProjectSearchGuidance(
                Object.assign(new Error("Embedding provider did not answer"), {
                    code: "provider-unavailable",
                }),
            ),
            /embedding model did not answer[\s\S]*OPENAI_COMPATIBLE_API_KEY/u,
        );
        assert.match(
            formatProjectSearchGuidance(
                Object.assign(new Error("Local reranking failed"), {
                    code: "reranking-failed",
                }),
            ),
            /reranker did not answer[\s\S]*--rerank-model/u,
        );
        assert.match(
            formatProjectSearchGuidance(new Error("something broke")),
            /Next: call search_codebase again once with the same query/u,
        );
    });
});

function fixtureResult() {
    return {
        score: 0.5,
        repositoryId: "repository-secret",
        snapshotId: "snapshot-secret",
        indexBuildId: "build-secret",
        documentId: "document-secret",
        chunkId: "chunk-secret",
        path: "src/auth/session.ts",
        language: "typescript",
        format: "code",
        content: "export function authenticate() {}",
        range: {
            startOffset: 0,
            endOffset: 29,
            startLine: 42,
            endLine: 42,
        },
    };
}

function fixture(
    result: Pick<ProjectSearchResult, "resultCount" | "results">,
): ProjectSearchResult {
    return {
        projectIdentifier: "project",
        root: "/project",
        databasePath: "/database.sqlite",
        indexBuildId: "build",
        retrievalSelection: {
            type: "latest-ready",
            indexBuildId: "build",
        },
        ...result,
    };
}

describe("compressed search result presentation", () => {
    it("prints each file once with separate exact ranges and keeps original match scores labeled", () => {
        const original = fixtureResult();
        const compression = {
            diagnostic: { documentId: original.documentId, path: original.path, status: "selected" as const, elapsedMs: 10 },
            excerpts: [2, 20].map((line) => ({
                documentId: original.documentId, fileRevisionId: "revision", path: original.path,
                range: { startLine: line, endLine: line, startOffset: 0, endOffset: 10 }, content: `selected-${line}`,
            })),
        };
        const text = formatProjectSearchResult(fixture({ results: [
            { ...original, compression }, { ...original, chunkId: "other", compression },
        ] }), "query", 10);
        assert.equal(text.match(/### /gu)?.length, 1);
        assert.match(text, /Returned: lines 2-2\./u);
        assert.match(text, /Returned: lines 20-20\./u);
        assert.doesNotMatch(text, /Returned: lines 2-20/u);
        assert.match(text, /Original best match/u);
        assert.doesNotMatch(text, /Relevance:/u);
        assert.ok(!text.includes(original.content));
    });
    it("reports valid empty compression separately from a retrieval miss", () => {
        const text = formatProjectSearchResult(fixture({ results: [], diagnostics: {
            retrievalMs: 1, rerankingMs: 2, compressionMs: 3,
            compression: [{ documentId: "doc", path: "a.ts", status: "empty", elapsedMs: 3 }],
        } }), "query", 10);
        assert.match(text, /Compression selected no relevant passages in a.ts/u);
        assert.match(text, /compression 3 ms/u);
    });
});
