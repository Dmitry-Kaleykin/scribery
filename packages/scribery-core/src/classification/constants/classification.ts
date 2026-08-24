import type {
    ContentKind,
    FileTrait,
} from "../contracts/classification.js";

export const CONTENT_KIND = {
    TEXT: "text",
    BINARY: "binary",
    UNKNOWN: "unknown",
} as const satisfies Record<string, ContentKind>;

export const FILE_TRAIT = {
    GENERATED: "generated",
    MINIFIED: "minified",
    LOCKFILE: "lockfile",
    CONFIGURATION: "configuration",
    DOCUMENTATION: "documentation",
    TEST: "test",
    DECLARATION: "declaration",
    EMPTY: "empty",
} as const satisfies Record<string, FileTrait>;

export const FILE_TRAIT_ORDER: readonly FileTrait[] = [
    FILE_TRAIT.GENERATED,
    FILE_TRAIT.MINIFIED,
    FILE_TRAIT.LOCKFILE,
    FILE_TRAIT.CONFIGURATION,
    FILE_TRAIT.DOCUMENTATION,
    FILE_TRAIT.TEST,
    FILE_TRAIT.DECLARATION,
    FILE_TRAIT.EMPTY,
];
