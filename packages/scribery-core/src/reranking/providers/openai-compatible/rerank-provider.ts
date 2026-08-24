import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL } from "../../../shared/index.js";
import {
    DEFAULT_RERANKING_BATCH_CANDIDATES,
    DEFAULT_RERANKING_BATCH_CHARACTERS,
    DEFAULT_RERANKING_REQUEST_TIMEOUT_MILLISECONDS,
    MAXIMUM_RERANKING_ERROR_RESPONSE_CHARACTERS,
} from "../../constants/defaults.js";
import type {
    RerankingModelIdentity,
    RerankingProvider,
    RerankingRequest,
    RerankingResult,
} from "../../contracts/reranking.js";
import { RerankingError } from "../../errors/reranking-error.js";

export interface OpenAiCompatibleRerankProviderOptions {
    model: string;
    baseUrl?: string;
    apiKey?: string | undefined;
    maximumCandidates?: number;
    maximumCharacters?: number;
    requestTimeoutMilliseconds?: number;
    revision?: string;
    fetch?: typeof globalThis.fetch;
}

interface RerankApiResult {
    index?: unknown;
    relevance_score?: unknown;
}

interface RerankApiResponse {
    results?: unknown;
}

/**
 * Scores a batch through the Cohere/Jina-style `POST /v1/rerank` protocol
 * implemented by runtimes such as oMLX.
 */
export class OpenAiCompatibleRerankProvider implements RerankingProvider {
    readonly identity: RerankingModelIdentity;
    readonly maximumCandidates: number;
    readonly maximumCharacters: number;
    readonly #baseUrl: string;
    readonly #apiKey: string | undefined;
    readonly #timeout: number;
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: OpenAiCompatibleRerankProviderOptions) {
        if (
            typeof options.model !== "string" ||
            options.model.trim().length === 0 ||
            !isPositiveSafeInteger(
                options.maximumCandidates ?? DEFAULT_RERANKING_BATCH_CANDIDATES,
            ) ||
            !isPositiveSafeInteger(
                options.maximumCharacters ?? DEFAULT_RERANKING_BATCH_CHARACTERS,
            ) ||
            !isPositiveSafeInteger(
                options.requestTimeoutMilliseconds ??
                    DEFAULT_RERANKING_REQUEST_TIMEOUT_MILLISECONDS,
            ) ||
            (options.fetch !== undefined && typeof options.fetch !== "function")
        ) {
            throw new RerankingError(
                "invalid-input",
                "OpenAI-compatible rerank endpoint configuration is invalid",
            );
        }

        this.identity = {
            provider: "openai-compatible-rerank",
            model: options.model.trim(),
            ...(options.revision === undefined
                ? {}
                : { revision: options.revision }),
        };
        this.maximumCandidates = options.maximumCandidates ??
            DEFAULT_RERANKING_BATCH_CANDIDATES;
        this.maximumCharacters = options.maximumCharacters ??
            DEFAULT_RERANKING_BATCH_CHARACTERS;
        this.#baseUrl = normalizeBaseUrl(
            options.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        );
        this.#apiKey = options.apiKey;
        this.#timeout = options.requestTimeoutMilliseconds ??
            DEFAULT_RERANKING_REQUEST_TIMEOUT_MILLISECONDS;
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async rerank(
        request: RerankingRequest,
    ): Promise<readonly RerankingResult[]> {
        if (
            request.query.trim().length === 0 ||
            request.candidates.length < 1 ||
            request.candidates.length > this.maximumCandidates
        ) {
            throw new RerankingError(
                "invalid-input",
                "OpenAI-compatible rerank request is invalid",
            );
        }

        const timeoutController = new AbortController();
        const timeout = setTimeout(() => {
            timeoutController.abort(new Error("Provider request timed out"));
        }, this.#timeout);
        const combinedSignal = request.signal === undefined
            ? timeoutController.signal
            : AbortSignal.any([request.signal, timeoutController.signal]);

        try {
            const response = await this.#fetch(`${this.#baseUrl}/rerank`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.#apiKey === undefined
                        ? {}
                        : { authorization: `Bearer ${this.#apiKey}` }),
                },
                body: JSON.stringify({
                    model: this.identity.model,
                    query: request.query,
                    documents: request.candidates.map(({ content }) => content),
                    top_n: request.candidates.length,
                    return_documents: false,
                }),
                signal: combinedSignal,
            });

            if (!response.ok) {
                const responseBody = await readErrorResponse(response);
                throw new RerankingError(
                    "provider-unavailable",
                    `Reranking request failed with status ${response.status}`,
                    {
                        status: response.status,
                        ...(responseBody === undefined ? {} : { responseBody }),
                    },
                );
            }

            let payload: RerankApiResponse;
            try {
                payload = await response.json() as RerankApiResponse;
            } catch (error: unknown) {
                throw invalidResponse(error);
            }
            return parseResults(payload, request.candidates);
        } catch (error: unknown) {
            if (error instanceof RerankingError) throw error;

            if (request.signal?.aborted === true) {
                throw new RerankingError(
                    "cancelled",
                    "Reranking request was cancelled",
                    {},
                    error,
                );
            }

            throw new RerankingError(
                "provider-unavailable",
                "OpenAI-compatible rerank endpoint is unavailable",
                { baseUrl: this.#baseUrl },
                error,
            );
        } finally {
            clearTimeout(timeout);
        }
    }
}

function parseResults(
    payload: RerankApiResponse,
    candidates: RerankingRequest["candidates"],
): readonly RerankingResult[] {
    if (!Array.isArray(payload.results) || payload.results.length !== candidates.length) {
        throw invalidResponse();
    }

    const scores = new Map<number, number>();
    for (const value of payload.results) {
        const result = value as RerankApiResult;
        if (
            typeof result !== "object" ||
            result === null ||
            !Number.isSafeInteger(result.index) ||
            (result.index as number) < 0 ||
            (result.index as number) >= candidates.length ||
            typeof result.relevance_score !== "number" ||
            !Number.isFinite(result.relevance_score) ||
            scores.has(result.index as number)
        ) {
            throw invalidResponse();
        }
        scores.set(result.index as number, result.relevance_score);
    }

    return candidates.map(({ id }, index) => ({ id, score: scores.get(index)! }));
}

async function readErrorResponse(response: Response): Promise<string | undefined> {
    try {
        const body = (await response.text()).trim();
        return body.length === 0
            ? undefined
            : body.slice(0, MAXIMUM_RERANKING_ERROR_RESPONSE_CHARACTERS);
    } catch {
        return undefined;
    }
}

function invalidResponse(cause?: unknown): RerankingError {
    return new RerankingError(
        "invalid-provider-response",
        "OpenAI-compatible rerank endpoint returned invalid candidate scores",
        {},
        cause,
    );
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function normalizeBaseUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("Unsupported protocol");
        }
        return url.toString().replace(/\/+$/u, "");
    } catch (error: unknown) {
        throw new RerankingError(
            "invalid-input",
            "Provider base URL must be an absolute HTTP or HTTPS URL",
            { baseUrl: value },
            error,
        );
    }
}
