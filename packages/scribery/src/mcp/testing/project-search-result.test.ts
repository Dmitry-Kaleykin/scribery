import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectSearchResult } from "scribery-code";
import { formatProjectSearchResult } from "../results/project-search-result.js";

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

        const text = formatProjectSearchResult(result);

        assert.match(text, /Found 1 relevant code excerpt\./u);
        assert.match(text, /### 1\. src\/auth\/session\.ts:42-44/u);
        assert.match(text, /Scope: class SessionService/u);
        assert.match(text, /Defines: method authenticate\(\): boolean/u);
        assert.match(text, /Imports: session from \.\/session\.js/u);
        assert.match(text, /````typescript/u);
        assert.match(text, /const session = readSession\(\);/u);
        assert.match(text, /export function authenticate/u);
        assert.doesNotMatch(
            text,
            /repository-secret|snapshot-secret|build-secret|document-secret/u,
        );
    });

    it("reports an empty result directly", () => {
        assert.equal(
            formatProjectSearchResult(fixture({ resultCount: 0, results: [] })),
            "No relevant code excerpts found.",
        );
    });
});

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
