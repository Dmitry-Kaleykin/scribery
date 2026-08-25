export const DANGLING_PREFIX_MAXIMUM_SIZE = 512;
export const DANGLING_PREFIX_MAXIMUM_SIZE_RATIO = 0.2;
export const STRUCTURAL_PREFIX_MAXIMUM_SIZE_RATIO = 0.5;

export const DANGLING_PREFIX_ENDINGS = [
    "=>",
    ",",
    "=",
    "{",
    "(",
    "[",
    ":",
] as const;

export const DANGLING_PREFIX_KEYWORDS = [
    "do",
    "else",
    "finally",
    "try",
] as const;
