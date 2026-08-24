interface KeyringEntry {
    getPassword(): Promise<string | null | undefined>;
    setPassword(password: string): Promise<void>;
    deleteCredential(): Promise<boolean>;
}

interface KeyringModule {
    AsyncEntry: new (service: string, username: string) => KeyringEntry;
}

export type KeyringLoader = () => Promise<KeyringModule>;

export interface ProfileCredentialStore {
    readonly displayName: string;
    isAvailable(): Promise<boolean>;
    get(profileName: string): Promise<string | undefined>;
    set(profileName: string, apiKey: string): Promise<void>;
    delete(profileName: string): Promise<boolean>;
    rename(currentName: string, nextName: string): Promise<boolean>;
}

const SERVICE = "scribery-tui";

export class SystemProfileCredentialStore implements ProfileCredentialStore {
    readonly displayName = systemCredentialStoreName();
    readonly #loadKeyring: KeyringLoader;
    #module: Promise<KeyringModule> | undefined;

    constructor(loadKeyring: KeyringLoader = async () => import("@napi-rs/keyring")) {
        this.#loadKeyring = loadKeyring;
    }

    async isAvailable(): Promise<boolean> {
        try {
            await this.#keyring();
            return true;
        } catch {
            return false;
        }
    }

    async get(profileName: string): Promise<string | undefined> {
        const entry = await this.#entry(profileName);
        const password = await entry.getPassword();
        return password ?? undefined;
    }

    async set(profileName: string, apiKey: string): Promise<void> {
        if (!apiKey) throw new Error("An API key cannot be empty");
        const entry = await this.#entry(profileName);
        await entry.setPassword(apiKey);
    }

    async delete(profileName: string): Promise<boolean> {
        const entry = await this.#entry(profileName);
        return entry.deleteCredential();
    }

    async rename(currentName: string, nextName: string): Promise<boolean> {
        const apiKey = await this.get(currentName);
        if (apiKey === undefined) return false;
        if (await this.get(nextName) !== undefined) {
            throw new Error(`A saved API key already exists for profile ${nextName}`);
        }
        await this.set(nextName, apiKey);
        try {
            if (!await this.delete(currentName)) {
                throw new Error(`Could not remove the saved API key for profile ${currentName}`);
            }
        } catch (error: unknown) {
            try {
                await this.delete(nextName);
            } catch (rollbackError: unknown) {
                throw new AggregateError(
                    [error, rollbackError],
                    "The saved API key could not be moved or restored",
                );
            }
            throw error;
        }
        return true;
    }

    async #entry(profileName: string): Promise<KeyringEntry> {
        const { AsyncEntry } = await this.#keyring();
        return new AsyncEntry(SERVICE, `provider-profile:${profileName}`);
    }

    #keyring(): Promise<KeyringModule> {
        this.#module ??= this.#loadKeyring();
        return this.#module;
    }
}

function systemCredentialStoreName(): string {
    if (process.platform === "darwin") return "macOS Keychain";
    if (process.platform === "win32") return "Windows Credential Manager";
    return "system keyring";
}
