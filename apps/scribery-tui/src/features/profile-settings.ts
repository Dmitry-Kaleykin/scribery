import { resolveEmbeddingDimensionsInput } from "./embedding-dimensions.js";
import {
    COMPRESSION_DEFAULTS,
    DEFAULT_COMPRESSION_MODEL,
    type ProviderProfile,
    type ProviderProfileService,
} from "scribery";
import type { FeatureUi } from "./contracts.js";
import { editSettings, type Setting } from "./settings-menu.js";

export type ProfileModelKind = "embedding" | "reranking" | "compression";

export interface ProfileSettingsOptions {
    ui: FeatureUi;
    profiles: ProviderProfileService;
    name: string;
    pickModel(profile: ProviderProfile, kind: ProfileModelKind): Promise<string | null | undefined>;
    providerService(name: string): Promise<ProviderProfileService>;
}

export async function editProfileSettings(options: ProfileSettingsOptions): Promise<void> {
    const { ui, profiles, name } = options;
    const menu = (title: string, settings: (profile: ProviderProfile) => readonly Setting<ProviderProfile>[]) =>
        editSettings({ ui, title, read: () => profiles.get(name), save: (profile) => profiles.set(profile), settings });
    const inspect = async (profile: ProviderProfile, model: string) =>
        (await (await options.providerService(name)).inspectEmbeddingModel(
            model, profile.embedding.baseUrl, profile.embedding.embeddingSuffix,
        )).dimensions;
    const text = (label: string, value: string) => ui.input(`Edit ${name}`, label, value);
    const number = async (label: string, value: number | undefined) => {
        const entered = await text(`${label} (empty uses default)`, value === undefined ? "" : String(value));
        if (entered === undefined) return undefined;
        if (!entered.trim()) return null;
        if (!/^\d+$/u.test(entered.trim()) || !Number.isSafeInteger(Number(entered)) || Number(entered) < 1) {
            throw new Error(`${label} must be a positive integer`);
        }
        return Number(entered);
    };
    const model = (kind: ProfileModelKind, label: string, description: string): Setting<ProviderProfile> => ({
        value: kind, label, description,
        async edit(profile) {
            const selected = await options.pickModel(profile, kind);
            if (selected === undefined) return undefined;
            if (kind === "embedding") {
                if (selected === null || selected === profile.embedding.model) return undefined;
                const dimensions = await inspect(profile, selected);
                return { ...profile, embedding: { ...profile.embedding, model: selected, dimensions } };
            }
            if (kind === "compression") return { ...profile, compression: {
                ...profile.compression, enabled: selected !== null,
                ...(selected === null ? {} : { model: selected }),
            } };
            if (selected === null) {
                const { reranking: _removed, ...rest } = profile;
                return rest;
            }
            return { ...profile, reranking: { provider: "openai-compatible-qwen3", ...profile.reranking, model: selected } };
        },
    });

    const endpoints = (profile: ProviderProfile): Setting<ProviderProfile>[] =>
        (["embedding", "reranking", "compression"] as const).map((kind) => ({
            value: kind, label: `${capitalize(kind)} endpoint`,
            description: profile[kind]?.baseUrl ?? (kind === "compression" ? "Use embedding endpoint" : "http://127.0.0.1:1234/v1 (default)"),
            async edit(current) {
                if (kind === "reranking" && current.reranking === undefined) {
                    throw new Error("Select a reranker model before setting its endpoint");
                }
                const selected = await text(`${capitalize(kind)} endpoint (empty resets it)`, current[kind]?.baseUrl ?? "");
                if (selected === undefined) return undefined;
                const { baseUrl: _previous, ...previous } = current[kind] ?? {};
                const updated = { ...previous, ...(selected.trim() ? { baseUrl: selected.trim() } : {}) };
                // The existing provider catalog validates URLs and the complete profile.
                return { ...current, [kind]: updated } as ProviderProfile;
            },
        }));

    const limits = (profile: ProviderProfile): Setting<ProviderProfile>[] => [{
        value: "embedding-batch", label: "Embedding batch size",
        description: String(profile.embedding.maximumInputs ?? "Default"),
        async edit(current) {
            const selected = await number("Embedding batch size", current.embedding.maximumInputs);
            if (selected === undefined) return undefined;
            const { maximumInputs: _previous, ...embedding } = current.embedding;
            return { ...current, embedding: { ...embedding, ...(selected === null ? {} : { maximumInputs: selected }) } };
        },
    }, ...([
        ["timeoutMs", "Compression timeout (ms)"],
        ["maximumFiles", "Compression file limit"],
        ["maximumInputTokens", "Compression input tokens"],
        ["maximumOutputTokens", "Compression output tokens"],
        ["maximumExcerptCharacters", "Compression excerpt characters"],
    ] as const).map(([key, label]): Setting<ProviderProfile> => ({
        value: key, label,
        description: String(profile.compression?.[key] ?? `${COMPRESSION_DEFAULTS[key]} (default)`),
        async edit(current) {
            const selected = await number(label, current.compression?.[key]);
            if (selected === undefined) return undefined;
            const compression = { ...current.compression };
            delete compression[key];
            if (selected !== null) compression[key] = selected;
            return { ...current, compression };
        },
    }))];

    await menu(`Edit ${name}`, (profile) => [
        model("embedding", "Embedding model", profile.embedding.model),
        model("reranking", "Reranker model", profile.reranking?.model ?? "Disabled"),
        model("compression", "Compression model", profile.compression?.enabled === false
            ? "Disabled" : profile.compression?.model ?? `${DEFAULT_COMPRESSION_MODEL} (default)`),
        { value: "endpoints", label: "Endpoints", description: "Embedding, reranking, and compression",
            async edit() { await menu(`${name} endpoints`, endpoints); return undefined; } },
        { value: "limits", label: "Limits and timeouts", description: "Batch size and compression budgets",
            async edit() { await menu(`${name} limits and timeouts`, limits); return undefined; } },
        { value: "dimensions", label: "Embedding dimensions", description: String(profile.embedding.dimensions),
            async edit(current) {
                const selected = await text("Embedding dimensions (auto detects them)", String(current.embedding.dimensions));
                if (selected === undefined) return undefined;
                const detected = selected.trim().toLowerCase() === "auto"
                    ? await inspect(current, current.embedding.model) : current.embedding.dimensions;
                const dimensions = resolveEmbeddingDimensionsInput(selected, detected);
                return { ...current, embedding: { ...current.embedding, dimensions } };
            } },
        { value: "suffix", label: "Embedding suffix", description: profile.embedding.embeddingSuffix || "None",
            async edit(current) {
                const selected = await text("Embedding suffix (empty clears it)", current.embedding.embeddingSuffix ?? "");
                if (selected === undefined) return undefined;
                const { embeddingSuffix: _previous, ...embedding } = current.embedding;
                return { ...current, embedding: { ...embedding, ...(selected ? { embeddingSuffix: selected } : {}) } };
            } },
        { value: "reranking-interface", label: "Reranker interface", description: profile.reranking?.provider ?? "Disabled",
            async edit(current) {
                if (current.reranking === undefined) throw new Error("Select a reranker model before setting its interface");
                const selected = await ui.pick("Reranker interface", [
                    { value: "openai-compatible-qwen3", label: "Qwen3 completions", description: "Yes/no token scoring" },
                    { value: "openai-compatible-rerank", label: "Rerank API", description: "Native batch reranking; does not use an instruction" },
                ]);
                if (selected === undefined) return undefined;
                const { provider: _previous, ...reranking } = current.reranking;
                if (selected.value === "openai-compatible-rerank") {
                    const { instruction: _instruction, ...compatible } = reranking as typeof reranking & { instruction?: string };
                    return { ...current, reranking: { ...compatible, provider: "openai-compatible-rerank" } };
                }
                return { ...current, reranking: { ...reranking, provider: "openai-compatible-qwen3" } };
            } },
        { value: "reranking-instruction", label: "Reranker instruction",
            description: profile.reranking !== undefined && "instruction" in profile.reranking ? profile.reranking.instruction || "Default" : "Default / not applicable",
            async edit(current) {
                if (current.reranking === undefined || current.reranking.provider === "openai-compatible-rerank") {
                    throw new Error("Reranker instructions require the Qwen3 completions interface");
                }
                const selected = await text("Reranker instruction (empty resets it)", current.reranking.instruction ?? "");
                if (selected === undefined) return undefined;
                const { instruction: _previous, ...reranking } = current.reranking;
                return { ...current, reranking: { ...reranking, ...(selected.trim() ? { instruction: selected.trim() } : {}) } };
            } },
    ]);
}

function capitalize(value: string): string { return value[0]!.toUpperCase() + value.slice(1); }
