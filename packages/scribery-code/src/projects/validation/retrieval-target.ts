export function normalizeRetrievalTargetName(value: string): string {
    const target = value.trim();

    if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(target) ||
        target.includes("..") ||
        target.includes("//") ||
        target.endsWith("/")
    ) {
        throw new Error(
            "Retrieval target must be 1-128 letters, numbers, dots, underscores, slashes, or hyphens",
        );
    }

    return target;
}
