import type { OpenAiCompatibleEmbeddingProfile } from "scribery-core";

export type ProjectIndexingProvider =
    | {
        type: "profile";
        profile: string;
    }
    | {
        type: "inline";
        embedding: OpenAiCompatibleEmbeddingProfile;
    };

export interface ProjectIndexingSettings {
    provider: ProjectIndexingProvider;
    target?: string;
    keepReplacedBuilds: number;
    allowDirty?: boolean;
    maximumChunkSize?: number;
    windows1251?: boolean;
    include?: readonly string[];
    exclude?: readonly string[];
}

export interface ProjectIndexingRecipe extends ProjectIndexingSettings {
    schemaVersion: 1;
    projectIdentifier: string;
    createdAt: string;
    updatedAt: string;
}
