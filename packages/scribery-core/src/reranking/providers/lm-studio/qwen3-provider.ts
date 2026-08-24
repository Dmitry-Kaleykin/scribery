import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL } from "../../../shared/index.js";
import {
    DEFAULT_RERANKING_BATCH_CANDIDATES,
    DEFAULT_RERANKING_BATCH_CHARACTERS,
    DEFAULT_RERANKING_CONCURRENT_REQUESTS,
    DEFAULT_RERANKING_REQUEST_TIMEOUT_MILLISECONDS,
    MAXIMUM_RERANKING_ERROR_RESPONSE_CHARACTERS,
    QWEN3_CODE_RERANKING_INSTRUCTION,
    QWEN3_RERANKING_FALSE_TOKEN_ID,
    QWEN3_RERANKING_LABEL_LOGIT_BIAS,
    QWEN3_RERANKING_TRUE_TOKEN_ID,
} from "../../constants/defaults.js";
import type {
    RerankingModelIdentity,
    RerankingProvider,
    RerankingRequest,
    RerankingResult,
} from "../../contracts/reranking.js";
import { RerankingError } from "../../errors/reranking-error.js";
import { formatQwen3RerankingPrompt } from "../../formatting/qwen3-prompt.js";
import { mapWithConcurrency } from "../../utils/map-with-concurrency.js";

export interface OpenAiCompatibleQwen3RerankingProviderOptions {
    model: string;
    baseUrl?: string;
    apiKey?: string | undefined;
    instruction?: string;
    maximumCandidates?: number;
    maximumCharacters?: number;
    maximumConcurrentRequests?: number;
    requestTimeoutMilliseconds?: number;
    revision?: string;
    fetch?: typeof globalThis.fetch;
}

interface CompletionChoice {
    index?: number;
    finish_reason?: unknown;
    text?: unknown;
    logprobs?: {
        top_logprobs?: unknown;
    } | null;
}

interface CompletionsResponse {
    choices?: CompletionChoice[];
    usage?: {
        completion_tokens?: unknown;
    };
}

export class OpenAiCompatibleQwen3RerankingProvider implements RerankingProvider {
    readonly identity: RerankingModelIdentity;
    readonly maximumCandidates: number;
    readonly maximumCharacters: number;
    readonly #baseUrl: string;
    readonly #apiKey: string | undefined;
    readonly #instruction: string;
    readonly #maximumConcurrentRequests: number;
    readonly #timeout: number;
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: OpenAiCompatibleQwen3RerankingProviderOptions) {
        if (
            typeof options.model !== "string" ||
            options.model.trim().length === 0 ||
            (options.instruction !== undefined &&
                options.instruction.trim().length === 0) ||
            !isPositiveSafeInteger(
                options.maximumCandidates ?? DEFAULT_RERANKING_BATCH_CANDIDATES,
            ) ||
            !isPositiveSafeInteger(
                options.maximumCharacters ?? DEFAULT_RERANKING_BATCH_CHARACTERS,
            ) ||
            !isPositiveSafeInteger(
                options.maximumConcurrentRequests ??
                    DEFAULT_RERANKING_CONCURRENT_REQUESTS,
            ) ||
            !isPositiveSafeInteger(
                options.requestTimeoutMilliseconds ??
                    DEFAULT_RERANKING_REQUEST_TIMEOUT_MILLISECONDS,
            ) ||
            (options.fetch !== undefined && typeof options.fetch !== "function")
        ) {
            throw new RerankingError(
                "invalid-input",
                "OpenAI-compatible Qwen3 reranking configuration is invalid",
            );
        }

        this.identity = {
            provider: "lm-studio-qwen3-reranker",
            model: options.model,
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
        this.#instruction = options.instruction ??
            QWEN3_CODE_RERANKING_INSTRUCTION;
        this.#maximumConcurrentRequests = options.maximumConcurrentRequests ??
            DEFAULT_RERANKING_CONCURRENT_REQUESTS;
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
                "Qwen3 reranking request is invalid",
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
            return await mapWithConcurrency(
                request.candidates,
                this.#maximumConcurrentRequests,
                async (candidate, index) => {
                    const response = await this.#fetch(
                        `${this.#baseUrl}/completions`,
                        {
                            method: "POST",
                            headers: {
                                "content-type": "application/json",
                                ...(this.#apiKey === undefined
                                    ? {}
                                    : { authorization: `Bearer ${this.#apiKey}` }),
                            },
                            body: JSON.stringify({
                                model: this.identity.model,
                                prompt: formatQwen3RerankingPrompt(
                                    this.#instruction,
                                    request.query,
                                    candidate.content,
                                ),
                                temperature: 0,
                                max_tokens: 1,
                                logprobs: 2,
                                logit_bias: {
                                    [QWEN3_RERANKING_FALSE_TOKEN_ID]:
                                        QWEN3_RERANKING_LABEL_LOGIT_BIAS,
                                    [QWEN3_RERANKING_TRUE_TOKEN_ID]:
                                        QWEN3_RERANKING_LABEL_LOGIT_BIAS,
                                },
                                echo: false,
                            }),
                            signal: combinedSignal,
                        },
                    );

                    if (!response.ok) {
                        const responseBody = await readErrorResponse(response);
                        throw new RerankingError(
                            "provider-unavailable",
                            `Reranking request failed with status ${response.status}`,
                            {
                                status: response.status,
                                candidateIndex: index,
                                ...(responseBody === undefined
                                    ? {}
                                    : { responseBody }),
                            },
                        );
                    }

                    const payload = await response.json() as CompletionsResponse;
                    if (
                        !Array.isArray(payload.choices) ||
                        payload.choices.length !== 1
                    ) {
                        throw invalidResponse();
                    }

                    const choice = payload.choices[0];
                    if (choice === undefined || (choice.index ?? 0) !== 0) {
                        throw invalidResponse();
                    }

                    return {
                        id: candidate.id,
                        score: scoreChoice(choice, payload.usage, index),
                    };
                },
            );
        } catch (error: unknown) {
            if (error instanceof RerankingError) {
                throw error;
            }

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
                "OpenAI-compatible completions endpoint is unavailable for reranking",
                { baseUrl: this.#baseUrl },
                error,
            );
        } finally {
            clearTimeout(timeout);
        }
    }
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

function scoreChoice(
    choice: CompletionChoice,
    usage: CompletionsResponse["usage"],
    candidateIndex: number,
): number {
    if (choice.logprobs !== null && choice.logprobs !== undefined) {
        return relevanceScore(choice.logprobs.top_logprobs);
    }

    if (typeof choice.text === "string") {
        const label = choice.text.trim().toLowerCase();
        if (label === "yes") return 1;
        if (label === "no") return 0;
    }

    throw missingLogprobs({
        candidateIndex,
        finishReason: choice.finish_reason,
        completionTokens: usage?.completion_tokens,
        generatedLabel: typeof choice.text === "string"
            ? choice.text.trim().slice(0, 20)
            : undefined,
    });
}

function relevanceScore(topLogprobs: unknown): number {
    if (!Array.isArray(topLogprobs) || topLogprobs.length < 1) {
        throw invalidResponse();
    }

    const firstTokenLogprobs = topLogprobs[0];

    if (
        typeof firstTokenLogprobs !== "object" ||
        firstTokenLogprobs === null ||
        Array.isArray(firstTokenLogprobs)
    ) {
        throw invalidResponse();
    }

    let yesLogprob: number | undefined;
    let noLogprob: number | undefined;

    for (const [token, value] of Object.entries(firstTokenLogprobs)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw invalidResponse();
        }

        const normalized = token.replace(/^[▁Ġ]+/u, "").trim().toLowerCase();

        if (normalized === "yes") yesLogprob = value;
        if (normalized === "no") noLogprob = value;
    }

    if (yesLogprob === undefined || noLogprob === undefined) {
        throw invalidResponse();
    }

    return sigmoid(yesLogprob - noLogprob);
}

function sigmoid(value: number): number {
    if (value >= 0) {
        const inverse = Math.exp(-value);
        return 1 / (1 + inverse);
    }

    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
}

function invalidResponse(): RerankingError {
    return new RerankingError(
        "invalid-provider-response",
        "OpenAI-compatible endpoint returned invalid Qwen3 reranking log-probabilities",
    );
}

function missingLogprobs(
    response: Readonly<Record<string, unknown>>,
): RerankingError {
    return new RerankingError(
        "invalid-provider-response",
        "OpenAI-compatible endpoint did not return next-token log-probabilities required by Qwen3 reranking",
        {
            ...response,
            requiredCapability: "next-token-logprobs",
            suggestedRuntime: "GGUF/llama.cpp",
        },
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

/** @deprecated Use OpenAiCompatibleQwen3RerankingProviderOptions. */
export type LmStudioQwen3RerankingProviderOptions = OpenAiCompatibleQwen3RerankingProviderOptions;

/** @deprecated Use OpenAiCompatibleQwen3RerankingProvider. */
export type LmStudioQwen3RerankingProvider = OpenAiCompatibleQwen3RerankingProvider;

/** @deprecated Use OpenAiCompatibleQwen3RerankingProvider. */
export const LmStudioQwen3RerankingProvider = OpenAiCompatibleQwen3RerankingProvider;
