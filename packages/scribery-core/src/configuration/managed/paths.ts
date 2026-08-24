import { homedir } from "node:os";
import { join } from "node:path";

import {
    SCRIBERY_HOME_DIRECTORY,
    INDEXING_PRESETS_FILENAME,
    PROVIDER_PROFILES_FILENAME,
} from "../../shared/index.js";

export function managedScriberyDirectory(): string {
    return join(homedir(), SCRIBERY_HOME_DIRECTORY);
}

export function managedProviderProfilesPath(
    scriberyDirectory = managedScriberyDirectory(),
): string {
    return join(scriberyDirectory, PROVIDER_PROFILES_FILENAME);
}

export function managedIndexingPresetsPath(
    scriberyDirectory = managedScriberyDirectory(),
): string {
    return join(scriberyDirectory, INDEXING_PRESETS_FILENAME);
}
