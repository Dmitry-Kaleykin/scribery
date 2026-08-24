import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
    SCRIBERY_HOME_DIRECTORY,
    MANAGED_DATABASE_FILENAME,
    MANAGED_INDEXES_DIRECTORY,
    MANAGED_PROJECT_IDENTIFIER_LENGTH,
    MANAGED_PROJECT_IDENTIFIER_PATTERN,
} from "scribery-core";

export function managedIndexesDirectory(): string {
    return join(
        homedir(),
        SCRIBERY_HOME_DIRECTORY,
        MANAGED_INDEXES_DIRECTORY,
    );
}

export function managedProjectIdentifier(root: string): string {
    return createHash("sha256")
        .update(resolve(root), "utf8")
        .digest("hex")
        .slice(0, MANAGED_PROJECT_IDENTIFIER_LENGTH);
}

export function managedProjectDirectory(
    projectIdentifier: string,
    indexesDirectory = managedIndexesDirectory(),
): string {
    validateManagedProjectIdentifier(projectIdentifier);
    return join(indexesDirectory, projectIdentifier);
}

export function managedDatabasePath(
    root: string,
    indexesDirectory = managedIndexesDirectory(),
): string {
    return join(
        managedProjectDirectory(
            managedProjectIdentifier(root),
            indexesDirectory,
        ),
        MANAGED_DATABASE_FILENAME,
    );
}

export function validateManagedProjectIdentifier(
    projectIdentifier: string,
): void {
    if (!MANAGED_PROJECT_IDENTIFIER_PATTERN.test(projectIdentifier)) {
        throw new Error(
            "Project identifier must contain exactly 24 lowercase hexadecimal characters",
        );
    }
}
