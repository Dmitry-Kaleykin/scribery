export interface EmbeddingProviderDiagnosticOptions {
    signal?: AbortSignal;
}

export interface EmbeddingProviderDiagnosticResult {
    provider: string;
    model: string;
    dimensions: number;
}
