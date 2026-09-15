import { resolveCompressionOptions, type CompressionProvider, type CompressionOptions } from "../compression/index.js";
import { compressResults } from "../compression/compress-results.js";
import {
    EmbeddingService,
    formatQueryEmbeddingInput,
    type EmbeddingProvider,
} from "../embeddings/index.js";
import { hashText } from "../metadata/index.js";
import {
    RerankingError,
    RerankingService,
    type RerankingProvider,
} from "../reranking/index.js";
import type { StorageProvider } from "../storage/index.js";
import {
    DEFAULT_RERANKING_CANDIDATE_MULTIPLIER,
    DEFAULT_RESULT_LIMIT,
    MAXIMUM_RERANKING_CANDIDATES,
    MAXIMUM_RESULT_LIMIT,
} from "./constants/limits.js";
import type {
    RetrievalRerankingOptions,
    RetrievalRequest,
    RetrievalResult,
} from "./contracts/retrieval.js";
import { RetrievalError } from "./errors/retrieval-error.js";
import { formatRerankingCandidate } from "./reranking/format-candidate.js";

interface ResolvedRerankingOptions {
    candidateLimit: number;
    failureMode: "error" | "use-semantic-order";
}

export class SemanticRetriever {
    readonly #compression: CompressionProvider | undefined;
    readonly #compressionOptions: CompressionOptions;
    readonly #storage: StorageProvider;
    readonly #embeddings: EmbeddingService;
    readonly #reranking: RerankingService | undefined;

    constructor(
        storage: StorageProvider,
        provider: EmbeddingProvider,
        rerankingProvider?: RerankingProvider,
        compressionProvider?: CompressionProvider,
        compressionOptions: CompressionOptions = {},
    ) {
        this.#compression = compressionProvider;
        this.#compressionOptions = compressionOptions;
        this.#storage = storage;
        this.#embeddings = new EmbeddingService(provider);
        this.#reranking = rerankingProvider === undefined
            ? undefined
            : new RerankingService(rerankingProvider);
    }

    async retrieve(
        request: RetrievalRequest,
    ): Promise<readonly RetrievalResult[]> {
        const started = performance.now();
        validateRequest(request);
        const compression = resolveCompressionOptions({ ...this.#compressionOptions, ...request.compression });
        if (compression.enabled && this.#compression === undefined) {
            throw new RetrievalError("invalid-request", "Compression is enabled but no provider is configured; configure a compression model or set compression.enabled to false");
        }
        const limit = request.limit ?? DEFAULT_RESULT_LIMIT;
        const rerankingOptions = request.rerank === undefined
            ? undefined
            : resolveRerankingOptions(request.rerank, limit);

        if (rerankingOptions !== undefined && this.#reranking === undefined) {
            throw new RetrievalError(
                "invalid-request",
                "Retrieval requested reranking without a configured provider",
            );
        }

        const build = await this.#storage.getBuild(request.indexBuildId);

        if (build === undefined || build.status !== "ready") {
            throw new RetrievalError(
                "build-not-ready",
                `Index build ${request.indexBuildId} is not ready`,
                { indexBuildId: request.indexBuildId },
            );
        }

        if (
            build.repositoryId !== request.repositoryId ||
            build.snapshotId !== request.snapshotId
        ) {
            throw new RetrievalError(
                "scope-mismatch",
                "Retrieval scope does not match the selected index build",
            );
        }

        const queryId = `query_${hashText(request.query).slice(7)}`;
        const [embedding] = await this.#embeddings.embed([
            formatQueryEmbeddingInput(
                queryId,
                request.query,
                this.#embeddings.provider.identity.queryPrefix,
                this.#embeddings.provider.identity.embeddingSuffix,
            ),
        ], request.signal === undefined ? {} : { signal: request.signal });

        if (embedding === undefined) {
            throw new RetrievalError(
                "invalid-request",
                "Query embedding was not produced",
            );
        }

        const results = await this.#storage.vectorSearch({
            repositoryId: request.repositoryId,
            snapshotId: request.snapshotId,
            indexBuildId: request.indexBuildId,
            vector: embedding.vector,
            modelIdentity: this.#embeddings.provider.identity,
            ...(request.filters === undefined ? {} : { filters: request.filters }),
            limit: rerankingOptions?.candidateLimit ?? limit,
        });

        let retrievalResults: readonly RetrievalResult[] = results.map(({
            score,
            document,
            chunk,
        }) => ({
            score,
            repositoryId: request.repositoryId,
            snapshotId: request.snapshotId,
            indexBuildId: request.indexBuildId,
            documentId: document.metadata.documentId,
            ...(document.metadata.sourceId === undefined
                ? {}
                : { sourceId: document.metadata.sourceId }),
            ...(document.metadata.title === undefined
                ? {}
                : { sourceTitle: document.metadata.title }),
            ...(document.metadata.sourceAttributes === undefined
                ? {}
                : { sourceAttributes: document.metadata.sourceAttributes }),
            chunkId: chunk.metadata.chunkId,
            path: document.metadata.path,
            language: document.metadata.language,
            format: document.metadata.format,
            content: chunk.content,
            range: {
                startOffset: chunk.metadata.startOffset,
                endOffset: chunk.metadata.endOffset,
                startLine: chunk.metadata.startLine,
                endLine: chunk.metadata.endLine,
            },
            ...(chunk.metadata.kind === undefined
                ? {}
                : { kind: chunk.metadata.kind }),
            ...(chunk.metadata.semanticContext === undefined
                ? {}
                : { semanticContext: chunk.metadata.semanticContext }),
        }));

        const retrievalMs = Math.round(performance.now() - started);
        const rerankingStarted = performance.now();
        if (rerankingOptions !== undefined && retrievalResults.length > 0) {
            retrievalResults = await this.#rerank(
                request,
                retrievalResults,
                rerankingOptions,
                limit,
            );
        }

        const rerankingMs = Math.round(performance.now() - rerankingStarted);
        const compressionStarted = performance.now();
        const compressed = compression.enabled
            ? await compressResults(this.#storage, request, retrievalResults, this.#compression!, compression)
            : { results: retrievalResults, diagnostics: [] };
        request.onDiagnostics?.({
            retrievalMs,
            rerankingMs,
            compressionMs: Math.round(performance.now() - compressionStarted),
            compression: compressed.diagnostics,
        });
        return compressed.results;
    }

    async #rerank(
        request: RetrievalRequest,
        results: readonly RetrievalResult[],
        options: ResolvedRerankingOptions,
        limit: number,
    ): Promise<readonly RetrievalResult[]> {
        try {
            const scores = await this.#reranking!.rerank(
                request.query,
                results.map((result) => ({
                    id: resultKey(result),
                    content: formatRerankingCandidate(result),
                })),
                request.signal,
            );
            const scoresById = new Map(scores.map(({ id, score }) => [id, score]));

            return results.map((result, semanticRank) => {
                const rerankScore = scoresById.get(resultKey(result));

                if (rerankScore === undefined) {
                    throw new RerankingError(
                        "invalid-provider-response",
                        "Reranker omitted a retrieval candidate",
                    );
                }

                return {
                    ...result,
                    score: rerankScore,
                    semanticScore: result.score,
                    rerankScore,
                    semanticRank,
                };
            }).sort((left, right) =>
                right.rerankScore - left.rerankScore ||
                left.semanticRank - right.semanticRank
            ).slice(0, limit).map(({ semanticRank: _semanticRank, ...result }) =>
                result
            );
        } catch (error: unknown) {
            if (
                request.signal?.aborted === true ||
                (error instanceof RerankingError && error.code === "cancelled")
            ) {
                throw new RetrievalError(
                    "cancelled",
                    "Retrieval was cancelled during reranking",
                    {},
                    error,
                );
            }

            if (options.failureMode === "use-semantic-order") {
                return results.slice(0, limit);
            }

            throw new RetrievalError(
                "reranking-failed",
                "Local reranking failed",
                {},
                error,
            );
        }
    }
}

function validateRequest(request: RetrievalRequest): void {
    const limit = request.limit ?? DEFAULT_RESULT_LIMIT;

    if (
        request.repositoryId.trim().length === 0 ||
        request.snapshotId.trim().length === 0 ||
        request.indexBuildId.trim().length === 0 ||
        request.query.trim().length === 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAXIMUM_RESULT_LIMIT
    ) {
        throw new RetrievalError(
            "invalid-request",
            "Retrieval request contains an invalid scope, query, or limit",
        );
    }

    if (request.signal?.aborted === true) {
        throw new RetrievalError(
            "cancelled",
            "Retrieval was cancelled",
            {},
            request.signal.reason,
        );
    }

    if (request.context !== undefined) {
        throw new RetrievalError("invalid-request", "Neighbor context expansion has been replaced by compression; use compression options instead of context");
    }

    if (request.rerank !== undefined) {
        resolveRerankingOptions(request.rerank, limit);
    }
}

function resolveRerankingOptions(
    options: RetrievalRerankingOptions,
    resultLimit: number,
): ResolvedRerankingOptions {
    const candidateLimit = options.candidateLimit ?? Math.min(
        MAXIMUM_RERANKING_CANDIDATES,
        resultLimit * DEFAULT_RERANKING_CANDIDATE_MULTIPLIER,
    );
    const failureMode = options.failureMode ?? "error";

    if (
        !Number.isSafeInteger(candidateLimit) ||
        candidateLimit < resultLimit ||
        candidateLimit > MAXIMUM_RERANKING_CANDIDATES ||
        !["error", "use-semantic-order"].includes(failureMode)
    ) {
        throw new RetrievalError(
            "invalid-request",
            "Retrieval reranking contains an invalid candidate limit or failure mode",
        );
    }

    return { candidateLimit, failureMode };
}

function resultKey(result: RetrievalResult): string {
    return `${result.documentId}\0${result.chunkId}`;
}
