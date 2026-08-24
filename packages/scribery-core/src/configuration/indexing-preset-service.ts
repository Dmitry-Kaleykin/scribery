import type {
    IndexingPreset,
    IndexingPresetInput,
} from "./contracts/indexing-preset.js";
import {
    IndexingPresetCatalog,
    normalizeIndexingPresetName,
} from "./managed/indexing-preset-catalog.js";
import {
    managedIndexingPresetsPath,
    managedProviderProfilesPath,
} from "./managed/paths.js";
import { ProviderProfileService } from "./provider-profile-service.js";

export interface IndexingPresetServiceOptions {
    presetsPath?: string;
    profilesPath?: string;
}

export class IndexingPresetService {
    readonly #catalog: IndexingPresetCatalog;
    readonly #profiles: ProviderProfileService;

    constructor(options: IndexingPresetServiceOptions = {}) {
        this.#catalog = new IndexingPresetCatalog(
            options.presetsPath ?? managedIndexingPresetsPath(),
        );
        this.#profiles = new ProviderProfileService({
            profilesPath: options.profilesPath ?? managedProviderProfilesPath(),
        });
    }

    async list(): Promise<readonly IndexingPreset[]> {
        return (await this.#catalog.read()).presets;
    }

    async get(name: string): Promise<IndexingPreset> {
        const normalized = normalizeIndexingPresetName(name);
        const preset = (await this.#catalog.read()).presets.find(
            ({ name: candidate }) => candidate === normalized,
        );
        if (preset === undefined) {
            throw new Error(`Indexing preset ${normalized} was not found`);
        }
        return preset;
    }

    async set(input: IndexingPresetInput): Promise<IndexingPreset> {
        await this.#profiles.get(input.providerProfile);
        const catalog = await this.#catalog.set(input);
        return catalog.presets.find(({ name }) =>
            name === normalizeIndexingPresetName(input.name)
        )!;
    }

    async remove(name: string): Promise<Readonly<Record<string, unknown>>> {
        const normalized = normalizeIndexingPresetName(name);
        const catalog = await this.#catalog.remove(normalized);
        return {
            removed: normalized,
            presetCount: catalog.presets.length,
        };
    }

    async rename(currentName: string, nextName: string): Promise<IndexingPreset> {
        const next = normalizeIndexingPresetName(nextName);
        const catalog = await this.#catalog.rename(currentName, next);
        return catalog.presets.find(({ name }) => name === next)!;
    }

    async replaceProviderProfileReferences(
        currentName: string,
        nextName: string,
    ): Promise<number> {
        return this.#catalog.replaceProviderProfileReferences(
            currentName,
            nextName,
        );
    }
}
