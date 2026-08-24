import {
    IndexingPresetService,
    ProviderProfileService,
    type ProviderProfile,
} from "scribery-core";
import { ProjectIndexingService } from "../indexing/project-indexing-service.js";

export interface ProviderProfileRenameServiceOptions {
    profilesPath?: string;
    presetsPath?: string;
    indexesDirectory?: string;
}

export interface ProviderProfileRenameResult {
    profile: ProviderProfile;
    updatedPresets: number;
    updatedProjectRecipes: number;
}

export class ProviderProfileRenameService {
    readonly #profiles: ProviderProfileService;
    readonly #presets: IndexingPresetService;
    readonly #projects: ProjectIndexingService;

    constructor(options: ProviderProfileRenameServiceOptions = {}) {
        this.#profiles = new ProviderProfileService({
            ...(options.profilesPath === undefined
                ? {}
                : { profilesPath: options.profilesPath }),
        });
        this.#presets = new IndexingPresetService({
            ...(options.profilesPath === undefined
                ? {}
                : { profilesPath: options.profilesPath }),
            ...(options.presetsPath === undefined
                ? {}
                : { presetsPath: options.presetsPath }),
        });
        this.#projects = new ProjectIndexingService({
            ...(options.profilesPath === undefined
                ? {}
                : { profilesPath: options.profilesPath }),
            ...(options.indexesDirectory === undefined
                ? {}
                : { indexesDirectory: options.indexesDirectory }),
        });
    }

    async rename(
        currentName: string,
        nextName: string,
    ): Promise<ProviderProfileRenameResult> {
        const profile = await this.#profiles.rename(currentName, nextName);
        let updatedPresets = 0;
        let updatedProjectRecipes = 0;
        try {
            updatedPresets = await this.#presets.replaceProviderProfileReferences(
                currentName,
                nextName,
            );
            updatedProjectRecipes = await this.#projects
                .replaceProviderProfileReferences(currentName, nextName);
            return { profile, updatedPresets, updatedProjectRecipes };
        } catch (error: unknown) {
            const rollbackErrors: unknown[] = [];
            if (updatedProjectRecipes > 0) {
                await captureFailure(
                    this.#projects.replaceProviderProfileReferences(
                        nextName,
                        currentName,
                    ),
                    rollbackErrors,
                );
            }
            if (updatedPresets > 0) {
                await captureFailure(
                    this.#presets.replaceProviderProfileReferences(
                        nextName,
                        currentName,
                    ),
                    rollbackErrors,
                );
            }
            await captureFailure(
                this.#profiles.rename(nextName, currentName),
                rollbackErrors,
            );
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    "Profile rename failed and could not be fully rolled back",
                );
            }
            throw error;
        }
    }
}

async function captureFailure(
    operation: Promise<unknown>,
    errors: unknown[],
): Promise<void> {
    try {
        await operation;
    } catch (error: unknown) {
        errors.push(error);
    }
}
