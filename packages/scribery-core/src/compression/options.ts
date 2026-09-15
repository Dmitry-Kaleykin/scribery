import type { CompressionOptions, CompressionProfile } from "./contracts.js";

export const DEFAULT_COMPRESSION_MODEL = "Qwen3.5-2B";
export const COMPRESSION_DEFAULTS: Required<CompressionOptions> = {
    enabled: true,
    timeoutMs: 30_000,
    maximumFiles: 5,
    maximumInputTokens: 16_384,
    maximumOutputTokens: 256,
    maximumExcerptCharacters: 12_000,
};

export function resolveCompressionOptions(options: CompressionOptions = {}): Required<CompressionOptions> {
    const resolved = { ...COMPRESSION_DEFAULTS, ...options };
    if (typeof resolved.enabled !== "boolean") throw new Error("Compression enabled must be a boolean");
    const maxima = { timeoutMs: 30_000, maximumFiles: 100, maximumInputTokens: 131_072,
        maximumOutputTokens: 4096, maximumExcerptCharacters: 100_000 };
    for (const key of Object.keys(maxima) as Array<keyof typeof maxima>) {
        if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1 || resolved[key] > maxima[key]) {
            throw new Error(`Compression ${key} must be an integer between 1 and ${maxima[key]}`);
        }
    }
    return resolved;
}

export function validateCompressionProfile(value: CompressionProfile): CompressionProfile {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Compression profile must be an object");
    }
    const allowed = [...Object.keys(COMPRESSION_DEFAULTS), "model", "baseUrl"];
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new Error(`Unknown compression option: ${key}`);
    }
    resolveCompressionOptions(value);
    if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
        throw new Error("Compression model must not be empty");
    }
    if (value.baseUrl !== undefined) {
        if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) throw new Error("Compression baseUrl is invalid");
        if (!["http:", "https:"].includes(new URL(value.baseUrl).protocol)) {
            throw new Error("Compression baseUrl must use HTTP or HTTPS");
        }
    }
    return {
        ...value,
        ...(value.model === undefined ? {} : { model: value.model.trim() }),
        ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl.trim().replace(/\/+$/u, "") }),
    };
}
