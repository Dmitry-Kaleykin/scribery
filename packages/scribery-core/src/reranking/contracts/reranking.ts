export interface RerankingModelIdentity {
    provider: string;
    model: string;
    revision?: string;
}

export interface RerankingCandidate {
    id: string;
    content: string;
}

export interface RerankingRequest {
    query: string;
    candidates: readonly RerankingCandidate[];
    signal?: AbortSignal;
}

export interface RerankingResult {
    id: string;
    score: number;
}

export interface RerankingProvider {
    readonly identity: RerankingModelIdentity;
    readonly maximumCandidates: number;
    readonly maximumCharacters: number;

    rerank(request: RerankingRequest): Promise<readonly RerankingResult[]>;
}
