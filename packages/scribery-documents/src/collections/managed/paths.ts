import { homedir } from "node:os";
import { join } from "node:path";

import { SCRIBERY_HOME_DIRECTORY } from "scribery-core";
import {
    COLLECTION_DATABASE_FILENAME,
    COLLECTION_MANIFEST_FILENAME,
    COLLECTION_SOURCES_DIRECTORY,
    MANAGED_COLLECTIONS_DIRECTORY,
} from "../constants/storage.js";

const COLLECTION_ID_PATTERN = /^collection_[a-f0-9]{64}$/u;
const SOURCE_ID_PATTERN = /^source_[a-f0-9]{64}$/u;

export function managedCollectionsDirectory(): string {
    return join(
        homedir(),
        SCRIBERY_HOME_DIRECTORY,
        MANAGED_COLLECTIONS_DIRECTORY,
    );
}

export function collectionDirectory(baseDirectory: string, collectionId: string): string {
    validateCollectionId(collectionId);
    return join(baseDirectory, collectionId);
}

export function collectionManifestPath(baseDirectory: string, collectionId: string): string {
    return join(
        collectionDirectory(baseDirectory, collectionId),
        COLLECTION_MANIFEST_FILENAME,
    );
}

export function collectionDatabasePath(baseDirectory: string, collectionId: string): string {
    return join(
        collectionDirectory(baseDirectory, collectionId),
        COLLECTION_DATABASE_FILENAME,
    );
}

export function collectionSourcePath(
    baseDirectory: string,
    collectionId: string,
    contentFilename: string,
): string {
    if (!SOURCE_ID_PATTERN.test(contentFilename.replace(/\.bin$/u, ""))) {
        throw new Error("Collection source content filename is invalid");
    }

    return join(
        collectionDirectory(baseDirectory, collectionId),
        COLLECTION_SOURCES_DIRECTORY,
        contentFilename,
    );
}

export function validateCollectionId(collectionId: string): void {
    if (!COLLECTION_ID_PATTERN.test(collectionId)) {
        throw new Error("Collection identifier is invalid");
    }
}
