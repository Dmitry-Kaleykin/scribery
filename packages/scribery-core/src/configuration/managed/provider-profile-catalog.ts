import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
    PROVIDER_PROFILES_VERSION,
} from "../../shared/index.js";
import type {
    OpenAiCompatibleEmbeddingProfile,
    OpenAiCompatibleRerankingProfile,
    ProviderProfile,
    ProviderProfileInput,
    ProviderProfiles,
} from "../contracts/provider-profile.js";
import { managedProviderProfilesPath } from "./paths.js";

export class ProviderProfileCatalog {
    readonly #path: string;

    constructor(path = managedProviderProfilesPath()) {
        this.#path = path;
    }

    async read(): Promise<ProviderProfiles> {
        try {
            return validateCatalog(JSON.parse(
                await readFile(this.#path, "utf8"),
            ) as unknown);
        } catch (error: unknown) {
            if (isMissing(error)) return emptyCatalog();
            throw error;
        }
    }

    async set(input: ProviderProfileInput): Promise<ProviderProfiles> {
        const normalized = validateInput(input);
        const catalog = await this.read();
        const previous = catalog.profiles.find(
            ({ name }) => name === normalized.name,
        );
        const now = new Date().toISOString();
        const profile: ProviderProfile = {
            ...normalized,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        const updated: ProviderProfiles = {
            schemaVersion: PROVIDER_PROFILES_VERSION,
            updatedAt: now,
            profiles: catalog.profiles
                .filter(({ name }) => name !== normalized.name)
                .concat(profile)
                .sort((left, right) => left.name.localeCompare(right.name)),
        };
        await this.#write(updated);
        return updated;
    }

    async remove(name: string): Promise<ProviderProfiles> {
        const profileName = normalizeProviderProfileName(name);
        const catalog = await this.read();

        if (!catalog.profiles.some(({ name }) => name === profileName)) {
            throw new Error(`Provider profile ${profileName} was not found`);
        }

        const updated: ProviderProfiles = {
            ...catalog,
            updatedAt: new Date().toISOString(),
            profiles: catalog.profiles.filter(({ name }) => name !== profileName),
        };
        await this.#write(updated);
        return updated;
    }

    async rename(currentName: string, nextName: string): Promise<ProviderProfiles> {
        const current = normalizeProviderProfileName(currentName);
        const next = normalizeProviderProfileName(nextName);
        const catalog = await this.read();
        const profile = catalog.profiles.find(({ name }) => name === current);
        if (profile === undefined) {
            throw new Error(`Provider profile ${current} was not found`);
        }
        if (current === next) return catalog;
        if (catalog.profiles.some(({ name }) => name === next)) {
            throw new Error(`Provider profile ${next} already exists`);
        }
        const now = new Date().toISOString();
        const updated: ProviderProfiles = {
            schemaVersion: PROVIDER_PROFILES_VERSION,
            updatedAt: now,
            profiles: catalog.profiles.map((candidate) =>
                candidate.name === current
                    ? { ...candidate, name: next, updatedAt: now }
                    : candidate
            ).sort((left, right) => left.name.localeCompare(right.name)),
        };
        await this.#write(updated);
        return updated;
    }

    async #write(catalog: ProviderProfiles): Promise<void> {
        const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
        await mkdir(dirname(this.#path), { recursive: true });
        await writeFile(
            temporaryPath,
            `${JSON.stringify(catalog, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryPath, this.#path);
    }
}

export function normalizeProviderProfileName(value: string): string {
    const name = value.trim();

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
        throw new Error(
            "Provider profile name must be 1-64 letters, numbers, dots, underscores, or hyphens",
        );
    }
    return name;
}

function emptyCatalog(): ProviderProfiles {
    return {
        schemaVersion: PROVIDER_PROFILES_VERSION,
        updatedAt: new Date(0).toISOString(),
        profiles: [],
    };
}

function validateCatalog(value: unknown): ProviderProfiles {
    if (
        !isRecord(value) ||
        value.schemaVersion !== PROVIDER_PROFILES_VERSION ||
        typeof value.updatedAt !== "string" ||
        !Array.isArray(value.profiles)
    ) {
        throw new Error("Provider profile catalog is invalid");
    }

    const profiles = value.profiles.map((profile): ProviderProfile => {
        if (
            !isRecord(profile) ||
            typeof profile.name !== "string" ||
            typeof profile.createdAt !== "string" ||
            typeof profile.updatedAt !== "string"
        ) {
            throw new Error("Provider profile catalog is invalid");
        }
        const normalized = validateInput({
            name: profile.name,
            embedding: profile.embedding as OpenAiCompatibleEmbeddingProfile,
            ...(profile.reranking === undefined
                ? {}
                : {
                    reranking: profile.reranking as OpenAiCompatibleRerankingProfile,
                }),
        });
        return {
            ...normalized,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
        };
    });
    if (new Set(profiles.map(({ name }) => name)).size !== profiles.length) {
        throw new Error("Provider profile catalog contains duplicate names");
    }
    return {
        schemaVersion: PROVIDER_PROFILES_VERSION,
        updatedAt: value.updatedAt,
        profiles: profiles.sort((left, right) => left.name.localeCompare(right.name)),
    };
}

function validateInput(input: ProviderProfileInput): ProviderProfileInput {
    const embedding = validateEmbedding(input.embedding);
    const reranking = input.reranking === undefined
        ? undefined
        : validateReranking(input.reranking);
    return {
        name: normalizeProviderProfileName(input.name),
        embedding,
        ...(reranking === undefined ? {} : { reranking }),
    };
}

function validateEmbedding(value: OpenAiCompatibleEmbeddingProfile): OpenAiCompatibleEmbeddingProfile {
    if (
        !isRecord(value) ||
        (value.provider !== "openai-compatible" &&
            value.provider !== "lm-studio") ||
        typeof value.model !== "string" ||
        value.model.trim().length === 0 ||
        !isPositiveInteger(value.dimensions) ||
        (value.maximumInputs !== undefined &&
            !isPositiveInteger(value.maximumInputs)) ||
        (value.embeddingSuffix !== undefined &&
            typeof value.embeddingSuffix !== "string")
    ) {
        throw new Error("Provider embedding profile is invalid");
    }
    const baseUrl = validateOptionalUrl(value.baseUrl);
    return {
        provider: "openai-compatible",
        model: value.model.trim(),
        dimensions: value.dimensions,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(value.maximumInputs === undefined
            ? {}
            : { maximumInputs: value.maximumInputs }),
        ...(value.embeddingSuffix === undefined
            ? {}
            : { embeddingSuffix: value.embeddingSuffix }),
    };
}

function validateReranking(
    value: OpenAiCompatibleRerankingProfile,
): OpenAiCompatibleRerankingProfile {
    if (
        !isRecord(value) ||
        (value.provider !== "openai-compatible-qwen3" &&
            value.provider !== "lm-studio-qwen3" &&
            value.provider !== "openai-compatible-rerank") ||
        typeof value.model !== "string" ||
        value.model.trim().length === 0 ||
        (value.instruction !== undefined &&
            (typeof value.instruction !== "string" ||
                value.instruction.trim().length === 0)) ||
        (value.provider === "openai-compatible-rerank" &&
            value.instruction !== undefined)
    ) {
        throw new Error("Provider reranking profile is invalid");
    }
    const baseUrl = validateOptionalUrl(value.baseUrl);
    if (value.provider === "openai-compatible-rerank") {
        return {
            provider: "openai-compatible-rerank",
            model: value.model.trim(),
            ...(baseUrl === undefined ? {} : { baseUrl }),
        };
    }
    return {
        provider: "openai-compatible-qwen3",
        model: value.model.trim(),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(value.instruction === undefined
            ? {}
            : { instruction: value.instruction }),
    };
}

function validateOptionalUrl(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("Provider base URL is invalid");
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Provider base URL must use HTTP or HTTPS");
    }
    return value.replace(/\/+$/u, "");
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
