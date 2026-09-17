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
            ? `No source passages selected for "${query}" in the searched index for ${searchedProject}. Retrieval returned candidates, but compression selected no relevant passages. Use compress: false to inspect the original candidates, or text search to check the working tree.`
            : emptyResultText(query, searchedProject);
        return [empty, ...diagnosticLines(result)].join("\n\n");
    }

    const candidates = visibleMatches(result.results);
    return [
        `search_codebase returned ${candidates.length} candidate${
            candidates.length === 1 ? "" : "s"
        } for "${query}".`,
        "Searched indexed source in " + searchedProject + ", highest-ranked first. " +
        "Candidates may be unrelated; scores indicate ranking, not verified relevance " +
        "or confidence probabilities. Recent edits may not yet be indexed. " +
        "Lines marked Returned are already in this response.",
        ...candidates.map((match, index) => formatMatch(match, index + 1)),
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
        `No candidates returned for "${query}" from the searched index for ${searchedProject}.`,
        "This does not establish that the code is absent; recent edits may not yet " +
        "be indexed. Try another description with known identifiers or domain " +
        "terms, or use text search to check the working tree.",
    ].join("\n\n");
}

function footer(
    result: ProjectSearchResult,
    requestedLimit: number,
): readonly string[] {
    return result.results.length < requestedLimit
        ? []
        : [`Retrieval limit reached (${requestedLimit} candidate chunk${requestedLimit === 1 ? "" : "s"}). Increase limit to request more; results are not exhaustive.`];
}

function formatMatch(result: RetrievalResult, rank: number): string {
    if (result.compression?.diagnostic.status === "selected") {
        return [
            `### ${rank}. ${result.path}`,
            `Original highest-ranked chunk: lines ${result.range.startLine}-${result.range.endLine}; ${rankingScore(result)}.`,
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
        rankingScore(result),
        ...(result.compression?.diagnostic.status === "fallback"
            ? [`Passage selection failed (${result.compression.diagnostic.reason ?? "unknown reason"}); showing the original candidate without relevance verification.`]
            : []),
        ...returnedLinesLine(result),
        ...semanticContextLines(result),
        `${fence}${fenceLanguage(result.language)}`,
        content,
        fence,
    ].join("\n");
}

function rankingScore(result: RetrievalResult): string {
    const source = result.rerankScore === undefined ? "vector" : "reranker";
    return `Ranking score (${source}): ${result.score.toPrecision(4)}`;
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
