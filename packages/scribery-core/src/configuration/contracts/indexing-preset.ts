export interface IndexingPresetInput {
    name: string;
    providerProfile: string;
    maximumChunkSize?: number;
    windows1251?: boolean;
    include?: readonly string[];
    exclude?: readonly string[];
}

export interface IndexingPreset extends IndexingPresetInput {
    createdAt: string;
    updatedAt: string;
}

export interface IndexingPresets {
    schemaVersion: 1;
    updatedAt: string;
    presets: readonly IndexingPreset[];
}
