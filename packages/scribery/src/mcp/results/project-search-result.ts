import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serializeError } from "scribery-core";

import type {
    ProjectSearchResult,
} from "scribery-code";
import type {
    RetrievalContextChunk,
    RetrievalResult,
} from "scribery-core";
import { mcpToolFailure } from "./tool-result.js";

/**
 * A failed search plus the reason and the concrete next command, so a failure
 * teaches the caller what to do next instead of teaching abandonment.
 */
export function projectSearchFailure(error: unknown): CallToolResult {
    const failure = mcpToolFailure(error);

    return {
        ...failure,
        content: [
            ...failure.content,
            { type: "text", text: formatProjectSearchGuidance(error) } as const,
        ],
    };
}

export function formatProjectSearchResult(
    result: ProjectSearchResult,
    query: string,
    requestedLimit: number,
): string {
    const searchedProject = result.root ?? result.projectIdentifier;

    if (result.results.length === 0) {
        const empty = result.diagnostics?.compression.some((file) => file.status === "empty")
            ? `Retrieval found candidate code for "${query}" in ${searchedProject}, but compression selected no relevant passages. Retry with compress: false to inspect the original matches.`
            : emptyResultText(query, searchedProject);
        return [empty, ...diagnosticLines(result)].join("\n\n");
    }

    return [
        `search_codebase found ${result.results.length} match${
            result.results.length === 1 ? "" : "es"
        } for "${query}".`,
        "Searched by meaning in " + searchedProject + ", best match first. Lines " +
        "marked Returned are already in this response.",
        ...visibleMatches(result.results).map((match, index) => formatMatch(match, index + 1)),
        ...diagnosticLines(result),
        ...footer(result, requestedLimit),
    ].join("\n\n");
}

/**
 * Turns a failed search into the reason plus the concrete retry, so that a
 * failure teaches the caller what to do next instead of teaching abandonment.
 */
export function formatProjectSearchGuidance(error: unknown): string {
    const failure = serializeError(error);
    const message = [
        failure.code ?? "",
        failure.message ?? "",
        failure.cause === undefined ? "" : JSON.stringify(failure.cause),
    ].join(" ").toLowerCase();

    const cases: ReadonlyArray<{
        guard: boolean;
        reason: string;
        nextStep: string;
    }> = [{
        guard: failure.code === "reranking-failed" || /rerank/u.test(message),
        reason: "the reranker did not answer, so the ranking could not be applied",
        nextStep: "call search_codebase again, or restart this server without " +
            "--rerank-model to search in embedding order",
    }, {
        guard: /no indexed projects are available/u.test(message),
        reason: "this server has no searchable project yet",
        nextStep: "run `scribery index <project-root>`, restart this server with " +
            "`--project <project-root>`, then call search_codebase again",
    }, {
        guard: /project .* was not found/u.test(message),
        reason: "that project is not one this server can resolve",
        nextStep: "call list_projects for the searchable projects and their exact " +
            "roots, then call search_codebase again",
    }, {
        guard: /no ready build|is not ready|build .* was not found/u.test(message),
        reason: "this project has no completed build to read from",
        nextStep: "run `scribery reindex <project>` or `scribery retrieval switch " +
            "<project> <target>`, then call search_codebase again",
    }, {
        guard: /dimension|model identity|model mismatch/u.test(message),
        reason: "the query embedding model differs from the model this project was " +
            "built with",
        nextStep: "restart this server with the --profile (or --base-url and " +
            "--model) used to index the project, then call search_codebase again",
    }, {
        guard: /embeddin|econnrefused|fetch failed|socket hang up|enotfound|timeout/u
            .test(message),
        reason: "the embedding model did not answer, so the query was never searched",
        nextStep: "start the embedding model and check this server's --profile, " +
            "--base-url, and OPENAI_COMPATIBLE_API_KEY, then call search_codebase " +
            "again with the same query",
    }, {
        guard: true,
        reason: "search_codebase stopped before returning results",
        nextStep: "call search_codebase again once with the same query; if it fails " +
            "again, search the working tree with your own text search",
    }];

    const match = cases.find(({ guard }) => guard)!;

    return [
        "The search failed. This is not an empty result.",
        `Reason: ${match.reason}.`,
        `Next: ${match.nextStep}.`,
    ].join("\n");
}

function emptyResultText(query: string, searchedProject: string): string {
    return [
        `No matches for "${query}" in ${searchedProject}.`,
        "search_codebase ran successfully: this wording did not match, which is a " +
        "normal result and not a tool failure.",
        [
            "Retry with different words:",
            "- describe the behavior instead of the name (\"where uploads are " +
            "retried\", \"what happens when a token expires\");",
            "- try a synonym, the abbreviation the code uses, a directory, a file " +
            "type, or the language name;",
            "- if you already know the identifier or filename, search the working " +
            "tree with your own text search instead.",
        ].join("\n"),
    ].join("\n\n");
}

function footer(
    result: ProjectSearchResult,
    requestedLimit: number,
): readonly string[] {
    return result.results.length < requestedLimit
        ? []
        : [`Capped at ${requestedLimit} matches. Pass a larger limit for more.`];
}

function formatMatch(result: RetrievalResult, rank: number): string {
    if (result.compression?.diagnostic.status === "selected") {
        return [
            `### ${rank}. ${result.path}`,
            `Original best match: lines ${result.range.startLine}-${result.range.endLine}; relevance ${result.score.toFixed(2)}.`,
            ...result.compression.excerpts.map((excerpt) => {
                const fence = codeFence(excerpt.content);
                return [`Returned: lines ${excerpt.range.startLine}-${excerpt.range.endLine}.`,
                    `${fence}${fenceLanguage(result.language)}`, excerpt.content, fence].join("\n");
            }),
        ].join("\n");
    }
    const content = joinedContent(result);
    const fence = codeFence(content);
    const location = result.range.startLine === result.range.endLine
        ? `${result.path}:${result.range.startLine}`
        : `${result.path}:${result.range.startLine}-${result.range.endLine}`;

    return [
        `### ${rank}. ${location}`,
        `Relevance: ${result.score.toFixed(2)}`,
        ...returnedLinesLine(result),
        ...semanticContextLines(result),
        `${fence}${fenceLanguage(result.language)}`,
        content,
        fence,
    ].join("\n");
}

function visibleMatches(results: readonly RetrievalResult[]): readonly RetrievalResult[] {
    const seen = new Set<string>();
    return results.filter((result) => {
        if (result.compression?.diagnostic.status !== "selected") return true;
        const key = `${result.indexBuildId}\0${result.documentId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function diagnosticLines(result: ProjectSearchResult): string[] {
    const diagnostics = result.diagnostics;
    if (diagnostics === undefined) return [];
    return [
        `Timing: retrieval ${diagnostics.retrievalMs} ms; reranking ${diagnostics.rerankingMs} ms; compression ${diagnostics.compressionMs} ms.`,
        ...diagnostics.compression.flatMap((file) => file.status === "fallback"
            ? [`Compression fallback for ${file.path}: ${file.reason}. Original matches returned.`]
            : file.status === "empty" ? [`Compression selected no relevant passages in ${file.path}.`]
                : file.inputTruncated ? [`Compression inspected bounded source sections in ${file.path}.`] : []),
    ];
}

function returnedLinesLine(result: RetrievalResult): readonly string[] {
    const neighbors = [
        ...(result.context?.before ?? []),
        ...(result.context?.after ?? []),
    ];
    const lines = [
        result.range.startLine,
        result.range.endLine,
        ...neighbors.map(({ range }) => range.startLine),
        ...neighbors.map(({ range }) => range.endLine),
    ].filter((line): line is number => typeof line === "number");

    const startLine = Math.min(...lines);
    const endLine = Math.max(...lines);

    return startLine === result.range.startLine && endLine === result.range.endLine
        ? []
        : [`Returned: lines ${startLine}-${endLine}.`];
}

function semanticContextLines(result: RetrievalResult): readonly string[] {
    const context = result.semanticContext;

    if (context === undefined) return [];

    return [
        ...(context.scope.length === 0
            ? []
            : [`Scope: ${context.scope.map((symbol) =>
                `${symbol.kind} ${symbol.name}`
            ).join(" > ")}`]),
        ...context.symbols.map((symbol) =>
            `Defines: ${symbol.kind} ${symbol.signature}`
        ),
        ...context.imports.map((syntaxImport) =>
            syntaxImport.bindings.length === 0
                ? `Imports: ${syntaxImport.source}`
                : `Imports: ${syntaxImport.bindings.join(", ")} from ` +
                    syntaxImport.source
        ),
    ];
}

function joinedContent(result: RetrievalResult): string {
    const chunks: Array<RetrievalContextChunk | { content: string }> = [
        ...(result.context?.before ?? []),
        { content: result.content },
        ...(result.context?.after ?? []),
    ];
    return chunks.map(({ content }) => content).join("\n");
}

function codeFence(content: string): string {
    const runs = content.match(/`+/gu) ?? [];
    const maximumRun = runs.reduce(
        (maximum, run) => Math.max(maximum, run.length),
        0,
    );
    return "`".repeat(Math.max(3, maximumRun + 1));
}

function fenceLanguage(language: string): string {
    return /^[a-z0-9_+-]+$/iu.test(language) ? language : "";
}
