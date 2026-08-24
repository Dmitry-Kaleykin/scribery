import type { RetrievalResult } from "../contracts/retrieval.js";

export function formatRerankingCandidate(result: RetrievalResult): string {
    return `Path: ${result.path}\nLanguage: ${result.language}\nCode:\n${result.content}`;
}
