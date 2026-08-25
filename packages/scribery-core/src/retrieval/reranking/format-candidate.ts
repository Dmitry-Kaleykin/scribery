import type { RetrievalResult } from "../contracts/retrieval.js";

export function formatRerankingCandidate(result: RetrievalResult): string {
    const semanticContext = result.semanticContext;
    const metadata = [
        `Path: ${result.path}`,
        `Language: ${result.language}`,
        ...(semanticContext === undefined || semanticContext.scope.length === 0
            ? []
            : [`Scope: ${semanticContext.scope.map((symbol) =>
                `${symbol.kind} ${symbol.name}`
            ).join(" > ")}`]),
        ...(semanticContext === undefined
            ? []
            : semanticContext.symbols.map((symbol) =>
                `Defines: ${symbol.kind} ${symbol.signature}`
            )),
        ...(semanticContext === undefined
            ? []
            : semanticContext.imports.map((syntaxImport) =>
                syntaxImport.bindings.length === 0
                    ? `Imports: ${syntaxImport.source}`
                    : `Imports: ${syntaxImport.bindings.join(", ")} from ` +
                        syntaxImport.source
            )),
    ];

    return `${metadata.join("\n")}\nCode:\n${result.content}`;
}
