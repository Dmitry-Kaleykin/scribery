import { EMBEDDING_FORMATTER_VERSION } from "../constants/defaults.js";
import type {
    DocumentEmbeddingContent,
    EmbeddingInput,
} from "../contracts/embedding.js";

export function formatDocumentEmbeddingInput(
    id: string,
    document: DocumentEmbeddingContent,
    prefix = "",
    suffix = "",
): EmbeddingInput {
    const header = [
        `formatter: ${EMBEDDING_FORMATTER_VERSION}`,
        `path: ${document.path}`,
        `language: ${document.language}`,
        ...(document.kind === undefined ? [] : [`kind: ${document.kind}`]),
        ...formatSemanticContext(document.semanticContext),
    ].join("\n");

    return {
        id,
        mode: "document",
        text: `${prefix}${header}\n\n${document.content}${suffix}`,
    };
}

function formatSemanticContext(
    context: DocumentEmbeddingContent["semanticContext"],
): readonly string[] {
    if (context === undefined) return [];

    return [
        ...(context.scope.length === 0
            ? []
            : [`scope: ${context.scope.map((symbol) =>
                `${symbol.kind} ${symbol.name}`
            ).join(" > ")}`]),
        ...context.symbols.map((symbol) =>
            `defines: ${symbol.kind} ${symbol.signature}`
        ),
        ...context.imports.map((syntaxImport) =>
            syntaxImport.bindings.length === 0
                ? `imports: ${syntaxImport.source}`
                : `imports: ${syntaxImport.bindings.join(", ")} from ${syntaxImport.source}`
        ),
    ];
}

export function formatQueryEmbeddingInput(
    id: string,
    query: string,
    prefix = "",
    suffix = "",
): EmbeddingInput {
    return {
        id,
        mode: "query",
        text: `${prefix}${query}${suffix}`,
    };
}
