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
    ].join("\n");

    return {
        id,
        mode: "document",
        text: `${prefix}${header}\n\n${document.content}${suffix}`,
    };
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
