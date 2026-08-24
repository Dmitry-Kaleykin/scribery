export function required(value: string | undefined, option: string): string {
    if (value === undefined || value.trim().length === 0) {
        throw new Error(`${option} is required`);
    }

    return value;
}

export function positiveInteger(value: string | undefined, option: string): number {
    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${option} must be a positive integer`);
    }

    return parsed;
}

export function nonNegativeInteger(
    value: string | undefined,
    option: string,
): number {
    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${option} must be a non-negative integer`);
    }

    return parsed;
}
