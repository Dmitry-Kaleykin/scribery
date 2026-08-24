import type { FileTrait } from "../../classification/index.js";

export const DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH = 10 * 1024 * 1024;

export const DEFAULT_CODE_ONLY_EXCLUDED_TRAITS = [
    "generated",
    "minified",
    "lockfile",
    "configuration",
] as const satisfies readonly FileTrait[];
