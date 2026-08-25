import type { EmbeddingModelIdentity } from "../../../metadata/index.js";
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL } from "../../../shared/index.js";
import type {
    EmbeddingInput,
    EmbeddingProvider,
    EmbeddingProviderOptions,
    EmbeddingResult,
} from "../../contracts/embedding.js";
import { EmbeddingError } from "../../errors/embedding-error.js";
import { MAXIMUM_PROVIDER_ERROR_RESPONSE_CHARACTERS } from "./constants/error-response.js";

export interface OpenAiCompatibleEmbeddingProviderOptions {
    model: string;
    dimensions: number;
    baseUrl?: string;
    apiKey?: string | undefined;
    maximumInputs?: number;
    maximumCharacters?: number;
    requestTimeoutMilliseconds?: number;
    revision?: string;
    documentPrefix?: string;
    queryPrefix?: string;
    embeddingSuffix?: string;
    fetch?: typeof globalThis.fetch;
}

interface EmbeddingsResponse {
    data?: Array<{
        index?: number;
        embedding?: unknown;
    }>;
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly identity: EmbeddingModelIdentity;
    readonly maximumInputs: number;
    readonly maximumCharacters: number;
    readonly #baseUrl: string;
    readonly #apiKey: string | undefined;
    readonly #timeout: number;
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: OpenAiCompatibleEmbeddingProviderOptions) {
        if (
            typeof options.model !== "string" ||
            options.model.trim().length === 0 ||
            !Number.isSafeInteger(options.dimensions) ||
            options.dimensions < 1 ||
            !isPositiveSafeInteger(options.maximumInputs ?? 32) ||
            !isPositiveSafeInteger(options.maximumCharacters ?? 64_000) ||
            !isPositiveSafeInteger(options.requestTimeoutMilliseconds ?? 60_000) ||
            (options.fetch !== undefined && typeof options.fetch !== "function")
        ) {
            throw new EmbeddingError(
                "invalid-input",
                "OpenAI-compatible model and dimensions must be configured",
            );
        }

        this.identity = {
            provider: "lm-studio-openai-compatible",
            model: options.model,
            dimensions: options.dimensions,
            metric: "cosine",
            ...(options.revision === undefined
                ? {}
                : { revision: options.revision }),
            ...(options.documentPrefix === undefined
                ? {}
                : { documentPrefix: options.documentPrefix }),
            ...(options.queryPrefix === undefined
                ? {}
                : { queryPrefix: options.queryPrefix }),
            ...(options.embeddingSuffix === undefined
                ? {}
                : { embeddingSuffix: options.embeddingSuffix }),
        };
        this.maximumInputs = options.maximumInputs ?? 32;
        this.maximumCharacters = options.maximumCharacters ?? 64_000;
        this.#baseUrl = normalizeBaseUrl(
            options.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        );
        this.#apiKey = options.apiKey;
        this.#timeout = options.requestTimeoutMilliseconds ?? 60_000;
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async embed(
        inputs: readonly EmbeddingInput[],
        options: EmbeddingProviderOptions = {},
    ): Promise<readonly EmbeddingResult[]> {
        const timeoutController = new AbortController();
        const timeout = setTimeout(() => {
            timeoutController.abort(new Error("Provider request timed out"));
        }, this.#timeout);
        const combinedSignal = options.signal === undefined
            ? timeoutController.signal
            : AbortSignal.any([options.signal, timeoutController.signal]);

        try {
            const response = await this.#fetch(`${this.#baseUrl}/embeddings`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.#apiKey === undefined
                        ? {}
                        : { authorization: `Bearer ${this.#apiKey}` }),
                },
                body: JSON.stringify({
                    model: this.identity.model,
                    input: inputs.map(({ text }) => text),
                    // The OpenAI-compatible base64 representation carries raw
                    // float32 values instead of verbose decimal JSON. Providers
                    // that ignore this and return float arrays remain supported.
                    encoding_format: "base64",
                }),
                signal: combinedSignal,
            });

            if (!response.ok) {
                const providerError = await readProviderError(response);

                throw new EmbeddingError(
                    "provider-unavailable",
                    providerError.message ??
                        `Embeddings request failed with status ${response.status}`,
                    {
                        status: response.status,
                        ...(providerError.responseBody === undefined
                            ? {}
                            : { responseBody: providerError.responseBody }),
                    },
                );
            }

            const payload = await response.json() as EmbeddingsResponse;

            if (!Array.isArray(payload.data)) {
                throw invalidResponse();
            }

            return payload.data.map((item, responseIndex) => {
                const index = item.index ?? responseIndex;
                const input = inputs[index];

                if (
                    input === undefined ||
                    !isEmbeddingPayload(item.embedding)
                ) {
                    throw invalidResponse();
                }

                return {
                    id: input.id,
                    vector: decodeEmbedding(item.embedding),
                };
            });
        } catch (error: unknown) {
            if (error instanceof EmbeddingError) {
                throw error;
            }

            if (options.signal?.aborted === true) {
                throw new EmbeddingError(
                    "cancelled",
                    "Embeddings request was cancelled",
                    {},
                    error,
                );
            }

            throw new EmbeddingError(
                "provider-unavailable",
                "OpenAI-compatible embeddings endpoint is unavailable",
                { baseUrl: this.#baseUrl },
                error,
            );
        } finally {
            clearTimeout(timeout);
        }
    }
}

function isEmbeddingPayload(value: unknown): value is number[] | string {
    return typeof value === "string" ||
        (Array.isArray(value) &&
            value.every((item) => typeof item === "number"));
}

function decodeEmbedding(payload: number[] | string): Float32Array {
    if (Array.isArray(payload)) {
        return Float32Array.from(payload);
    }

    const bytes = Buffer.from(payload, "base64");

    if (bytes.byteLength === 0 || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw invalidResponse();
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vector = new Float32Array(
        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );

    for (let index = 0; index < vector.length; index += 1) {
        vector[index] = view.getFloat32(
            index * Float32Array.BYTES_PER_ELEMENT,
            true,
        );
    }

    return vector;
}

function invalidResponse(): EmbeddingError {
    return new EmbeddingError(
        "invalid-provider-response",
        "OpenAI-compatible endpoint returned an invalid embeddings response",
    );
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

async function readProviderError(response: Response): Promise<{
    message?: string;
    responseBody?: string;
}> {
    let responseBody: string;

    try {
        responseBody = (await response.text()).trim();
    } catch {
        return {};
    }

    if (responseBody.length === 0) {
        return {};
    }

    const message = extractProviderMessage(responseBody);

    return {
        ...(message === undefined ? {} : { message }),
        responseBody: responseBody.slice(
            0,
            MAXIMUM_PROVIDER_ERROR_RESPONSE_CHARACTERS,
        ),
    };
}

function extractProviderMessage(responseBody: string): string | undefined {
    try {
        const payload = JSON.parse(responseBody) as unknown;

        if (!isRecord(payload)) {
            return undefined;
        }

        const error = payload.error;

        if (typeof error === "string" && error.length > 0) {
            return error;
        }

        if (
            isRecord(error) &&
            typeof error.message === "string" &&
            error.message.length > 0
        ) {
            return error.message;
        }

        return typeof payload.message === "string" && payload.message.length > 0
            ? payload.message
            : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
    try {
        const url = new URL(value);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("Unsupported protocol");
        }

        return url.toString().replace(/\/+$/u, "");
    } catch (error: unknown) {
        throw new EmbeddingError(
            "invalid-input",
            "Provider base URL must be an absolute HTTP or HTTPS URL",
            { baseUrl: value },
            error,
        );
    }
}

/** @deprecated Use OpenAiCompatibleEmbeddingProviderOptions. */
export type LmStudioEmbeddingProviderOptions = OpenAiCompatibleEmbeddingProviderOptions;

/** @deprecated Use OpenAiCompatibleEmbeddingProvider. */
export type LmStudioEmbeddingProvider = OpenAiCompatibleEmbeddingProvider;

/** @deprecated Use OpenAiCompatibleEmbeddingProvider. */
export const LmStudioEmbeddingProvider = OpenAiCompatibleEmbeddingProvider;
