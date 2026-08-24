import type { FileTrait } from "scribery-core";

export const DEFAULT_CODE_ONLY_EXCLUDED_TRAITS = [
    "generated",
    "minified",
    "lockfile",
    "configuration",
] as const satisfies readonly FileTrait[];
