import { validateCompressionProfile, type CompressionProfile } from "scribery-core";
import { positiveInteger } from "./values.js";

export const compressionFlags = {
    "compression-model": { type: "string" },
    "compression-base-url": { type: "string" },
    "compression-timeout": { type: "string" },
    "compression-files": { type: "string" },
    "compression-input-tokens": { type: "string" },
    "compression-output-tokens": { type: "string" },
    "compression-characters": { type: "string" },
    "no-compression": { type: "boolean" },
    compression: { type: "boolean" },
} as const;

export function compressionFromFlags(
    values: Partial<Record<keyof typeof compressionFlags, string | boolean>>,
    profile: CompressionProfile = {},
    baseUrl?: string,
): CompressionProfile {
    if (values.compression === true && values["no-compression"] === true) {
        throw new Error("--compression and --no-compression cannot be combined");
    }
    const result: CompressionProfile = { ...(baseUrl === undefined ? {} : { baseUrl }), ...profile };
    if (values["no-compression"] === true) result.enabled = false;
    if (values.compression === true) result.enabled = true;
    for (const [flag, field] of [["compression-model", "model"], ["compression-base-url", "baseUrl"]] as const) {
        const value = values[flag];
        if (typeof value === "string") result[field] = value;
    }
    for (const [flag, field] of [
        ["compression-timeout", "timeoutMs"], ["compression-files", "maximumFiles"],
        ["compression-input-tokens", "maximumInputTokens"], ["compression-output-tokens", "maximumOutputTokens"],
        ["compression-characters", "maximumExcerptCharacters"],
    ] as const) {
        const value = values[flag];
        if (typeof value === "string") result[field] = positiveInteger(value, `--${flag}`);
    }
    return validateCompressionProfile(result);
}
