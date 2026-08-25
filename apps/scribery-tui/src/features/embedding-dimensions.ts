export function resolveEmbeddingDimensionsInput(
    value: string,
    detectedDimensions: number,
): number {
    const normalized = value.trim().toLowerCase();

    if (normalized === "auto") {
        if (
            !Number.isSafeInteger(detectedDimensions) ||
            detectedDimensions < 1
        ) {
            throw new Error("Detected embedding dimensions must be a positive integer");
        }

        return detectedDimensions;
    }

    if (!/^\d+$/u.test(normalized)) {
        throw new Error(
            "Embedding dimensions must be auto or a positive integer",
        );
    }

    const parsed = Number(normalized);

    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(
            "Embedding dimensions must be auto or a positive integer",
        );
    }

    return parsed;
}
