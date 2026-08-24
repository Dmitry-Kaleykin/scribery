import type {
    RerankingCandidate,
    RerankingProvider,
    RerankingResult,
} from "./contracts/reranking.js";
import { RerankingError } from "./errors/reranking-error.js";

export class RerankingService {
    readonly provider: RerankingProvider;

    constructor(provider: RerankingProvider) {
        validateProvider(provider);
        this.provider = provider;
    }

    async rerank(
        query: string,
        candidates: readonly RerankingCandidate[],
        signal?: AbortSignal,
    ): Promise<readonly RerankingResult[]> {
        validateInput(query, candidates, signal);
        const batches = createBatches(
            query,
            candidates,
            this.provider.maximumCandidates,
            this.provider.maximumCharacters,
        );
        const scores = new Map<string, number>();

        for (const batch of batches) {
            throwIfCancelled(signal);
            const results = await this.provider.rerank({
                query,
                candidates: batch,
                ...(signal === undefined ? {} : { signal }),
            });
            validateBatchResults(batch, results);

            for (const result of results) {
                scores.set(result.id, result.score);
            }
        }

        throwIfCancelled(signal);
        return candidates.map(({ id }) => ({ id, score: scores.get(id)! }));
    }
}

function validateProvider(provider: RerankingProvider): void {
    if (
        provider.identity.provider.trim().length === 0 ||
        provider.identity.model.trim().length === 0 ||
        !isPositiveSafeInteger(provider.maximumCandidates) ||
        !isPositiveSafeInteger(provider.maximumCharacters)
    ) {
        throw new RerankingError(
            "invalid-input",
            "Reranking provider limits and identity must be configured",
        );
    }
}

function validateInput(
    query: string,
    candidates: readonly RerankingCandidate[],
    signal: AbortSignal | undefined,
): void {
    throwIfCancelled(signal);

    if (query.trim().length === 0 || candidates.length === 0) {
        throw new RerankingError(
            "invalid-input",
            "Reranking requires a query and at least one candidate",
        );
    }

    const ids = new Set<string>();

    for (const candidate of candidates) {
        if (candidate.id.trim().length === 0 || candidate.content.length === 0) {
            throw new RerankingError(
                "invalid-input",
                "Reranking candidate identity and content are required",
            );
        }

        if (ids.has(candidate.id)) {
            throw new RerankingError(
                "duplicate-candidate",
                `Reranking candidate ${candidate.id} is duplicated`,
                { candidateId: candidate.id },
            );
        }

        ids.add(candidate.id);
    }
}

function createBatches(
    query: string,
    candidates: readonly RerankingCandidate[],
    maximumCandidates: number,
    maximumCharacters: number,
): readonly (readonly RerankingCandidate[])[] {
    const batches: RerankingCandidate[][] = [];
    let batch: RerankingCandidate[] = [];
    let batchCharacters = 0;

    for (const candidate of candidates) {
        const characters = query.length + candidate.content.length;

        if (characters > maximumCharacters) {
            throw new RerankingError(
                "input-too-large",
                `Reranking candidate ${candidate.id} exceeds the provider limit`,
                { candidateId: candidate.id, characters, maximumCharacters },
            );
        }

        if (
            batch.length >= maximumCandidates ||
            batchCharacters + characters > maximumCharacters
        ) {
            batches.push(batch);
            batch = [];
            batchCharacters = 0;
        }

        batch.push(candidate);
        batchCharacters += characters;
    }

    if (batch.length > 0) {
        batches.push(batch);
    }

    return batches;
}

function validateBatchResults(
    candidates: readonly RerankingCandidate[],
    results: readonly RerankingResult[],
): void {
    const expectedIds = new Set(candidates.map(({ id }) => id));
    const resultIds = new Set<string>();

    for (const result of results) {
        if (
            !expectedIds.has(result.id) ||
            resultIds.has(result.id) ||
            !Number.isFinite(result.score)
        ) {
            throw invalidResponse();
        }

        resultIds.add(result.id);
    }

    if (resultIds.size !== expectedIds.size) {
        throw invalidResponse();
    }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new RerankingError(
            "cancelled",
            "Reranking was cancelled",
            {},
            signal.reason,
        );
    }
}

function invalidResponse(): RerankingError {
    return new RerankingError(
        "invalid-provider-response",
        "Reranking provider returned invalid candidate scores",
    );
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}
