import {
    ProjectIndexingService,
    ProjectSearchService,
    ProviderProfileService,
} from "scribery";

import type { ProfileCredentialStore } from "./profile-credential-store.js";

export class ProviderAccess {
    readonly #credentials: ProfileCredentialStore;
    readonly #environmentApiKey: string | undefined;
    readonly #sessionApiKeys = new Map<string, string>();
    readonly #storedApiKeyCache = new Map<string, string | null>();
    #credentialAvailability: Promise<boolean> | undefined;

    constructor(credentials: ProfileCredentialStore) {
        this.#credentials = credentials;
        this.#environmentApiKey = environmentApiKey();
    }

    get credentialDisplayName(): string {
        return this.#credentials.displayName;
    }

    get environmentApiKey(): string | undefined {
        return this.#environmentApiKey;
    }

    hasSessionApiKey(profileName: string): boolean {
        return this.#sessionApiKeys.has(profileName);
    }

    sessionApiKey(profileName: string): string | undefined {
        return this.#sessionApiKeys.get(profileName);
    }

    setSessionApiKey(profileName: string, apiKey: string): void {
        this.#sessionApiKeys.set(profileName, apiKey);
    }

    clearSessionApiKey(profileName: string): void {
        this.#sessionApiKeys.delete(profileName);
    }

    async credentialsAvailable(): Promise<boolean> {
        this.#credentialAvailability ??= this.#credentials.isAvailable();
        return this.#credentialAvailability;
    }

    async storedApiKey(profileName: string): Promise<string | undefined> {
        if (this.#storedApiKeyCache.has(profileName)) {
            return this.#storedApiKeyCache.get(profileName) ?? undefined;
        }
        if (!await this.credentialsAvailable()) {
            this.#storedApiKeyCache.set(profileName, null);
            return undefined;
        }
        const apiKey = await this.#credentials.get(profileName);
        this.#storedApiKeyCache.set(profileName, apiKey ?? null);
        return apiKey;
    }

    async saveApiKey(profileName: string, apiKey: string): Promise<void> {
        await this.#credentials.set(profileName, apiKey);
        this.#storedApiKeyCache.set(profileName, apiKey);
        this.#sessionApiKeys.delete(profileName);
    }

    async deleteSavedApiKey(profileName: string): Promise<boolean> {
        const deleted = await this.#credentials.delete(profileName);
        if (deleted) this.#storedApiKeyCache.set(profileName, null);
        return deleted;
    }

    async restoreSavedApiKey(profileName: string, apiKey: string): Promise<void> {
        await this.#credentials.set(profileName, apiKey);
        this.#storedApiKeyCache.set(profileName, apiKey);
    }

    async renameSavedApiKey(currentName: string, nextName: string): Promise<boolean> {
        const renamed = await this.#credentials.rename(currentName, nextName);
        if (renamed) {
            const saved = this.#storedApiKeyCache.get(currentName);
            this.#storedApiKeyCache.delete(currentName);
            if (saved !== undefined) this.#storedApiKeyCache.set(nextName, saved);
        }
        return renamed;
    }

    moveSessionApiKey(currentName: string, nextName: string): void {
        const apiKey = this.#sessionApiKeys.get(currentName);
        if (apiKey === undefined) return;
        this.#sessionApiKeys.delete(currentName);
        this.#sessionApiKeys.set(nextName, apiKey);
    }

    forgetProfile(profileName: string): void {
        this.#storedApiKeyCache.delete(profileName);
        this.#sessionApiKeys.delete(profileName);
    }

    async apiKey(profileName: string): Promise<string | undefined> {
        return this.#sessionApiKeys.get(profileName)
            ?? await this.storedApiKey(profileName)
            ?? this.#environmentApiKey;
    }

    async apiKeySource(profileName: string): Promise<string> {
        if (this.#sessionApiKeys.has(profileName)) return "from this session";
        if (await this.storedApiKey(profileName) !== undefined) {
            return `from ${this.#credentials.displayName}`;
        }
        return this.#environmentApiKey === undefined
            ? "not set"
            : "from the environment";
    }

    async profileService(profileName: string): Promise<ProviderProfileService> {
        return new ProviderProfileService(apiKeyOptions(await this.apiKey(profileName)));
    }

    async indexingService(profileName: string): Promise<ProjectIndexingService> {
        return new ProjectIndexingService(apiKeyOptions(await this.apiKey(profileName)));
    }

    async searchService(profileName: string): Promise<ProjectSearchService> {
        return new ProjectSearchService(apiKeyOptions(await this.apiKey(profileName)));
    }
}

export function apiKeyOptions(
    apiKey: string | undefined,
): { apiKey?: string } {
    return apiKey === undefined ? {} : { apiKey };
}

function environmentApiKey(): string | undefined {
    return process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY;
}
