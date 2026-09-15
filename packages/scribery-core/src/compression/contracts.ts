import type { SourceRange } from "../metadata/index.js";

export interface CompressionOptions {
    enabled?: boolean;
    timeoutMs?: number;
    maximumFiles?: number;
    maximumInputTokens?: number;
    maximumOutputTokens?: number;
    maximumExcerptCharacters?: number;
}

export interface CompressionProfile extends CompressionOptions {
    model?: string;
    baseUrl?: string;
}

export interface CompressionExcerpt {
    documentId: string;
    fileRevisionId: string;
    path: string;
    range: SourceRange;
    content: string;
}

export interface CompressionDiagnostic {
    documentId: string;
    path: string;
    status: "selected" | "empty" | "fallback";
    reason?: "timeout" | "provider-error" | "invalid-selection" | "file-limit" | "input-budget" | "source-unavailable";
    inputTruncated?: boolean;
    elapsedMs: number;
}

export interface CompressionSelection {
    startLine: number;
    endLine: number;
}

export interface CompressionProvider {
    select(request: {
        query: string;
        path: string;
        source: string;
        maximumOutputTokens: number;
        signal: AbortSignal;
    }): Promise<readonly CompressionSelection[]>;
}

export interface RetrievalDiagnostics {
    retrievalMs: number;
    rerankingMs: number;
    compressionMs: number;
    compression: readonly CompressionDiagnostic[];
}
