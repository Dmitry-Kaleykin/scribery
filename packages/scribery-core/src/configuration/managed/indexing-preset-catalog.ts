import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
    INDEXING_PRESETS_VERSION,
} from "../../shared/index.js";
import type {
    IndexingPreset,
    IndexingPresetInput,
    IndexingPresets,
} from "../contracts/indexing-preset.js";
import { normalizeProviderProfileName } from "./provider-profile-catalog.js";
import { managedIndexingPresetsPath } from "./paths.js";

export class IndexingPresetCatalog {
    readonly #path: string;

    constructor(path = managedIndexingPresetsPath()) {
        this.#path = path;
    }

    async read(): Promise<IndexingPresets> {
        try {
            return validateCatalog(JSON.parse(
                await readFile(this.#path, "utf8"),
            ) as unknown);
        } catch (error: unknown) {
            if (isMissing(error)) return emptyCatalog();
            throw error;
        }
    }

    async set(input: IndexingPresetInput): Promise<IndexingPresets> {
        const normalized = validateInput(input);
        const catalog = await this.read();
        const previous = catalog.presets.find(
            ({ name }) => name === normalized.name,
        );
        const now = new Date().toISOString();
        const preset: IndexingPreset = {
            ...normalized,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        const updated: IndexingPresets = {
            schemaVersion: INDEXING_PRESETS_VERSION,
            updatedAt: now,
            presets: catalog.presets
                .filter(({ name }) => name !== normalized.name)
                .concat(preset)
                .sort((left, right) => left.name.localeCompare(right.name)),
        };
        await this.#write(updated);
        return updated;
    }

    async remove(name: string): Promise<IndexingPresets> {
        const presetName = normalizeIndexingPresetName(name);
        const catalog = await this.read();

        if (!catalog.presets.some(({ name }) => name === presetName)) {
            throw new Error(`Indexing preset ${presetName} was not found`);
        }

        const updated: IndexingPresets = {
            ...catalog,
            updatedAt: new Date().toISOString(),
            presets: catalog.presets.filter(({ name }) => name !== presetName),
        };
        await this.#write(updated);
        return updated;
    }

    async rename(currentName: string, nextName: string): Promise<IndexingPresets> {
        const current = normalizeIndexingPresetName(currentName);
        const next = normalizeIndexingPresetName(nextName);
        const catalog = await this.read();
        const preset = catalog.presets.find(({ name }) => name === current);
        if (preset === undefined) {
            throw new Error(`Indexing preset ${current} was not found`);
        }
        if (current === next) return catalog;
        if (catalog.presets.some(({ name }) => name === next)) {
            throw new Error(`Indexing preset ${next} already exists`);
        }
        const now = new Date().toISOString();
        const updated: IndexingPresets = {
            schemaVersion: INDEXING_PRESETS_VERSION,
            updatedAt: now,
            presets: catalog.presets.map((candidate) =>
                candidate.name === current
                    ? { ...candidate, name: next, updatedAt: now }
                    : candidate
            ).sort((left, right) => left.name.localeCompare(right.name)),
        };
        await this.#write(updated);
        return updated;
    }

    async replaceProviderProfileReferences(
        currentName: string,
        nextName: string,
    ): Promise<number> {
        const current = normalizeProviderProfileName(currentName);
        const next = normalizeProviderProfileName(nextName);
        if (current === next) return 0;
        const catalog = await this.read();
        const affected = catalog.presets.filter(
            ({ providerProfile }) => providerProfile === current,
        );
        if (affected.length === 0) return 0;
        const now = new Date().toISOString();
        await this.#write({
            schemaVersion: INDEXING_PRESETS_VERSION,
            updatedAt: now,
            presets: catalog.presets.map((preset) =>
                preset.providerProfile === current
                    ? { ...preset, providerProfile: next, updatedAt: now }
                    : preset
            ),
        });
        return affected.length;
    }

    async #write(catalog: IndexingPresets): Promise<void> {
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

export function normalizeIndexingPresetName(value: string): string {
    const name = value.trim();

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
        throw new Error(
            "Indexing preset name must be 1-64 letters, numbers, dots, underscores, or hyphens",
        );
    }
    return name;
}

function emptyCatalog(): IndexingPresets {
    return {
        schemaVersion: INDEXING_PRESETS_VERSION,
        updatedAt: new Date(0).toISOString(),
        presets: [],
    };
}

function validateCatalog(value: unknown): IndexingPresets {
    if (
        !isRecord(value) ||
        value.schemaVersion !== INDEXING_PRESETS_VERSION ||
        typeof value.updatedAt !== "string" ||
        !Array.isArray(value.presets)
    ) {
        throw new Error("Indexing preset catalog is invalid");
    }

    const presets = value.presets.map((preset): IndexingPreset => {
        if (
            !isRecord(preset) ||
            typeof preset.name !== "string" ||
            typeof preset.providerProfile !== "string" ||
            typeof preset.createdAt !== "string" ||
            typeof preset.updatedAt !== "string"
        ) {
            throw new Error("Indexing preset catalog is invalid");
        }
        const normalized = validateInput({
            name: preset.name,
            providerProfile: preset.providerProfile,
            ...(preset.maximumChunkSize === undefined
                ? {}
                : { maximumChunkSize: preset.maximumChunkSize as number }),
            ...(preset.windows1251 === undefined
                ? {}
                : { windows1251: preset.windows1251 as boolean }),
            ...(preset.include === undefined
                ? {}
                : { include: preset.include as readonly string[] }),
            ...(preset.exclude === undefined
                ? {}
                : { exclude: preset.exclude as readonly string[] }),
        });
        return {
            ...normalized,
            createdAt: preset.createdAt,
            updatedAt: preset.updatedAt,
        };
    });

    if (new Set(presets.map(({ name }) => name)).size !== presets.length) {
        throw new Error("Indexing preset catalog contains duplicate names");
    }

    return {
        schemaVersion: INDEXING_PRESETS_VERSION,
        updatedAt: value.updatedAt,
        presets: presets.sort((left, right) => left.name.localeCompare(right.name)),
    };
}

function validateInput(input: IndexingPresetInput): IndexingPresetInput {
    if (
        input.maximumChunkSize !== undefined &&
        (
            !Number.isSafeInteger(input.maximumChunkSize) ||
            input.maximumChunkSize < 1
        )
    ) {
        throw new Error("Indexing preset chunk size must be a positive integer");
    }
    if (
        input.windows1251 !== undefined &&
        typeof input.windows1251 !== "boolean"
    ) {
        throw new Error("Indexing preset Windows-1251 setting is invalid");
    }

    const include = validatePatterns(input.include, "include");
    const exclude = validatePatterns(input.exclude, "exclude");

    return {
        name: normalizeIndexingPresetName(input.name),
        providerProfile: normalizeProviderProfileName(input.providerProfile),
        ...(input.maximumChunkSize === undefined
            ? {}
            : { maximumChunkSize: input.maximumChunkSize }),
        ...(input.windows1251 === undefined
            ? {}
            : { windows1251: input.windows1251 }),
        ...(include === undefined ? {} : { include }),
        ...(exclude === undefined ? {} : { exclude }),
    };
}

function validatePatterns(
    patterns: readonly string[] | undefined,
    field: string,
): readonly string[] | undefined {
    if (patterns === undefined) return undefined;
    if (
        !Array.isArray(patterns) ||
        patterns.some((pattern) =>
            typeof pattern !== "string" || pattern.trim().length === 0
        )
    ) {
        throw new Error(`Indexing preset ${field} patterns are invalid`);
    }
    return [...new Set(patterns.map((pattern) => pattern.trim()))];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
