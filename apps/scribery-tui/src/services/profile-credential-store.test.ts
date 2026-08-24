import assert from "node:assert/strict";
import test from "node:test";

import {
    SystemProfileCredentialStore,
    type KeyringLoader,
} from "./profile-credential-store.js";

function memoryKeyring(): {
    readonly credentials: Map<string, string>;
    readonly failedDeletes: Set<string>;
    readonly loader: KeyringLoader;
} {
    const credentials = new Map<string, string>();
    const failedDeletes = new Set<string>();
    class Entry {
        readonly #key: string;
        readonly #username: string;

        constructor(service: string, username: string) {
            this.#key = `${service}:${username}`;
            this.#username = username;
        }

        async getPassword(): Promise<string | undefined> {
            return credentials.get(this.#key);
        }

        async setPassword(password: string): Promise<void> {
            credentials.set(this.#key, password);
        }

        async deleteCredential(): Promise<boolean> {
            if (failedDeletes.has(this.#username)) throw new Error("delete failed");
            return credentials.delete(this.#key);
        }
    }
    return { credentials, failedDeletes, loader: async () => ({ AsyncEntry: Entry }) };
}

test("stores, reads, and deletes a profile API key", async () => {
    const keyring = memoryKeyring();
    const store = new SystemProfileCredentialStore(keyring.loader);

    assert.equal(await store.get("local"), undefined);
    await store.set("local", "secret");
    assert.equal(await store.get("local"), "secret");
    assert.equal(await store.delete("local"), true);
    assert.equal(await store.get("local"), undefined);
});

test("moves a saved API key when its profile is renamed", async () => {
    const keyring = memoryKeyring();
    const store = new SystemProfileCredentialStore(keyring.loader);
    await store.set("old", "secret");

    assert.equal(await store.rename("old", "new"), true);
    assert.equal(await store.get("old"), undefined);
    assert.equal(await store.get("new"), "secret");
});

test("does not overwrite a saved API key during rename", async () => {
    const keyring = memoryKeyring();
    const store = new SystemProfileCredentialStore(keyring.loader);
    await store.set("old", "old-secret");
    await store.set("new", "new-secret");

    await assert.rejects(store.rename("old", "new"), /already exists/u);
    assert.equal(await store.get("old"), "old-secret");
    assert.equal(await store.get("new"), "new-secret");
});

test("restores the original state when a credential rename cannot finish", async () => {
    const keyring = memoryKeyring();
    const store = new SystemProfileCredentialStore(keyring.loader);
    await store.set("old", "secret");
    keyring.failedDeletes.add("provider-profile:old");

    await assert.rejects(store.rename("old", "new"), /delete failed/u);
    assert.equal(await store.get("old"), "secret");
    assert.equal(await store.get("new"), undefined);
});

test("reports an unavailable native credential store without throwing", async () => {
    const store = new SystemProfileCredentialStore(async () => {
        throw new Error("native module unavailable");
    });

    assert.equal(await store.isAvailable(), false);
});
