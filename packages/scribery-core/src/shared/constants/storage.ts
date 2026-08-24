export const SCRIBERY_HOME_DIRECTORY = ".scribery";
export const MANAGED_INDEXES_DIRECTORY = "indexes";
export const MANAGED_DATABASE_FILENAME = "index.sqlite";
export const MANAGED_PROJECT_MANIFEST_FILENAME = "project.json";
export const RETRIEVAL_TARGETS_FILENAME = "retrieval-targets.json";
export const INDEXING_RECIPE_FILENAME = "indexing-recipe.json";
export const PROVIDER_PROFILES_FILENAME = "provider-profiles.json";
export const INDEXING_PRESETS_FILENAME = "indexing-presets.json";
export const INDEX_LOGS_DIRECTORY = "logs";
export const MANAGED_PROJECT_IDENTIFIER_LENGTH = 24;
export const MANAGED_PROJECT_IDENTIFIER_PATTERN = new RegExp(
    `^[a-f0-9]{${MANAGED_PROJECT_IDENTIFIER_LENGTH}}$`,
    "u",
);
export const MANAGED_PROJECT_MANIFEST_VERSION = 1;
export const RETRIEVAL_TARGETS_VERSION = 1;
export const INDEXING_RECIPE_VERSION = 1;
export const PROVIDER_PROFILES_VERSION = 1;
export const INDEXING_PRESETS_VERSION = 1;
export const INDEX_LOG_VERSION = 1;
