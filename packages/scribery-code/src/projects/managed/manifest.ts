import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
    MANAGED_PROJECT_MANIFEST_FILENAME,
    MANAGED_PROJECT_MANIFEST_VERSION,
} from "scribery-core";
import {
    managedDatabasePath,
    managedIndexesDirectory,
    managedProjectIdentifier,
} from "./paths.js";

export interface ManagedProjectManifest {
    schemaVersion: typeof MANAGED_PROJECT_MANIFEST_VERSION;
    projectIdentifier: string;
    root: string;
    createdAt: string;
    updatedAt: string;
}

export async function writeManagedProjectManifest(
    root: string,
    databasePath: string,
    indexesDirectory = managedIndexesDirectory(),
): Promise<ManagedProjectManifest | undefined> {
    const resolvedRoot = resolve(root);
    const resolvedDatabasePath = resolve(databasePath);

    if (
        resolvedDatabasePath !== managedDatabasePath(
            resolvedRoot,
            indexesDirectory,
        )
    ) {
        return undefined;
    }

    const projectIdentifier = managedProjectIdentifier(resolvedRoot);
    const manifestPath = join(
        dirname(resolvedDatabasePath),
        MANAGED_PROJECT_MANIFEST_FILENAME,
    );
    const previous = await readManagedProjectManifest(manifestPath);
    const now = new Date().toISOString();
    const manifest: ManagedProjectManifest = {
        schemaVersion: MANAGED_PROJECT_MANIFEST_VERSION,
        projectIdentifier,
        root: resolvedRoot,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
    };

    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
    );
    return manifest;
}

export async function readManagedProjectManifest(
    manifestPath: string,
): Promise<ManagedProjectManifest | undefined> {
    try {
        const parsed = JSON.parse(
            await readFile(manifestPath, "utf8"),
        ) as Partial<ManagedProjectManifest>;

        if (
            parsed.schemaVersion !== MANAGED_PROJECT_MANIFEST_VERSION ||
            typeof parsed.projectIdentifier !== "string" ||
            typeof parsed.root !== "string" ||
            typeof parsed.createdAt !== "string" ||
            typeof parsed.updatedAt !== "string"
        ) {
            return undefined;
        }

        return parsed as ManagedProjectManifest;
    } catch {
        return undefined;
    }
}
