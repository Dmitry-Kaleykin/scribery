import type {
    ProjectSearchResult,
} from "scribery-code";
import type {
    RetrievalContextChunk,
    RetrievalResult,
} from "scribery-core";

export function formatProjectSearchResult(result: ProjectSearchResult): string {
    if (result.results.length === 0) {
        return "No relevant code excerpts found.";
    }

    const excerpts = result.results.map((match, index) =>
        formatMatch(match, index + 1)
    );
    return [
        `Found ${result.results.length} relevant code excerpt${
            result.results.length === 1 ? "" : "s"
        }.`,
        ...excerpts,
    ].join("\n\n");
}

function formatMatch(result: RetrievalResult, rank: number): string {
    const content = joinedContent(result);
    const fence = codeFence(content);
    const location = result.range.startLine === result.range.endLine
        ? `${result.path}:${result.range.startLine}`
        : `${result.path}:${result.range.startLine}-${result.range.endLine}`;

    return [
        `### ${rank}. ${location}`,
        ...semanticContextLines(result),
        `${fence}${fenceLanguage(result.language)}`,
        content,
        fence,
    ].join("\n");
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
