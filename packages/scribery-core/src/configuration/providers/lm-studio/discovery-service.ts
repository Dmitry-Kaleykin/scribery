import {
    OpenAiCompatibleEmbeddingProvider,
} from "../../../embeddings/index.js";
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL } from "../../../shared/index.js";
import type {
    OpenAiCompatibleConnectionOptions,
    OpenAiCompatibleEmbeddingInspection,
    OpenAiCompatibleModelSummary,
} from "../../contracts/lm-studio.js";

export class OpenAiCompatibleDiscoveryService {
    readonly #baseUrl: string;
    readonly #apiKey: string | undefined;
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: OpenAiCompatibleConnectionOptions = {}) {
        this.#baseUrl = normalizeBaseUrl(
            options.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        );
        this.#apiKey = options.apiKey;
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async listModels(signal?: AbortSignal): Promise<readonly OpenAiCompatibleModelSummary[]> {
        const response = await this.#fetch(`${this.#baseUrl}/models`, {
            headers: this.#headers(),
            ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) {
            throw new Error(
                `OpenAI-compatible model listing failed with status ${response.status}`,
            );
        }
        const value = await response.json() as unknown;
        if (!isRecord(value) || !Array.isArray(value.data)) {
            throw new Error("OpenAI-compatible endpoint returned an invalid model list");
        }
        return value.data.map((model): OpenAiCompatibleModelSummary => {
            if (!isRecord(model) || typeof model.id !== "string") {
                throw new Error("OpenAI-compatible endpoint returned an invalid model list");
            }
            return {
                id: model.id,
                ...(typeof model.object === "string"
                    ? { object: model.object }
                    : {}),
                ...(typeof model.owned_by === "string"
                    ? { ownedBy: model.owned_by }
                    : {}),
            };
        }).sort((left, right) => left.id.localeCompare(right.id));
    }

    async inspectEmbeddingModel(
        model: string,
        embeddingSuffix?: string,
        signal?: AbortSignal,
    ): Promise<OpenAiCompatibleEmbeddingInspection> {
        const normalizedModel = model.trim();
        if (normalizedModel.length === 0) {
            throw new Error("Embedding model identifier must not be empty");
        }
        const provider = new OpenAiCompatibleEmbeddingProvider({
            model: normalizedModel,
            dimensions: 1,
            baseUrl: this.#baseUrl,
            ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
            fetch: this.#fetch,
        });
        const [result] = await provider.embed([{
            id: "provider-inspection",
            mode: "document",
            text: `Scribery embedding model inspection.${embeddingSuffix ?? ""}`,
        }], {
            ...(signal === undefined ? {} : { signal }),
        });
        if (
            result === undefined ||
            result.vector.length < 1 ||
            result.vector.some((value) => !Number.isFinite(value))
        ) {
            throw new Error("OpenAI-compatible endpoint returned an invalid embedding vector");
        }
        return {
            provider: "openai-compatible",
            model: normalizedModel,
            dimensions: result.vector.length,
        };
    }

    #headers(): Record<string, string> {
        return this.#apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.#apiKey}` };
    }
}

function normalizeBaseUrl(value: string): string {
    const baseUrl = value.trim().replace(/\/+$/u, "");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Provider base URL must use HTTP or HTTPS");
    }
    return baseUrl;
}

/** @deprecated Use OpenAiCompatibleDiscoveryService. */
export const LmStudioDiscoveryService = OpenAiCompatibleDiscoveryService;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
