import { homedir } from "node:os";
import { join } from "node:path";

import { SCRIBERY_HOME_DIRECTORY } from "scribery-core";
import {
    DOCUMENTATION_DATABASE_FILENAME,
    DOCUMENTATION_MANIFEST_FILENAME,
    DOCUMENTATION_SOURCES_DIRECTORY,
    MANAGED_DOCUMENTATIONS_DIRECTORY,
} from "../constants/storage.js";

const DOCUMENTATION_ID_PATTERN = /^documentation_[a-f0-9]{64}$/u;
const SOURCE_ID_PATTERN = /^source_[a-f0-9]{64}$/u;

export function managedDocumentationsDirectory(): string {
    return join(
        homedir(),
        SCRIBERY_HOME_DIRECTORY,
        MANAGED_DOCUMENTATIONS_DIRECTORY,
    );
}

export function documentationDirectory(baseDirectory: string, documentationId: string): string {
    validateDocumentationId(documentationId);
    return join(baseDirectory, documentationId);
}

export function documentationManifestPath(baseDirectory: string, documentationId: string): string {
    return join(
        documentationDirectory(baseDirectory, documentationId),
        DOCUMENTATION_MANIFEST_FILENAME,
    );
}

export function documentationDatabasePath(baseDirectory: string, documentationId: string): string {
    return join(
        documentationDirectory(baseDirectory, documentationId),
        DOCUMENTATION_DATABASE_FILENAME,
    );
}

export function documentationSourcePath(
    baseDirectory: string,
    documentationId: string,
    contentFilename: string,
): string {
    if (!SOURCE_ID_PATTERN.test(contentFilename.replace(/\.bin$/u, ""))) {
        throw new Error("Documentation source content filename is invalid");
    }

    return join(
        documentationDirectory(baseDirectory, documentationId),
        DOCUMENTATION_SOURCES_DIRECTORY,
        contentFilename,
    );
}

export function validateDocumentationId(documentationId: string): void {
    if (!DOCUMENTATION_ID_PATTERN.test(documentationId)) {
        throw new Error("Documentation identifier is invalid");
    }
}
