interface ErrorMetadata extends Error {
    code?: unknown;
    details?: unknown;
    cause?: unknown;
}

const MAXIMUM_CAUSE_DEPTH = 6;

export function formatError(error: unknown): string {
    const lines: string[] = [];
    const visited = new Set<unknown>();
    let current: unknown = error;
    let depth = 0;

    while (current !== undefined && depth < MAXIMUM_CAUSE_DEPTH) {
        if (visited.has(current)) {
            lines.push("Caused by: [circular error cause]");
            break;
        }
        visited.add(current);

        if (!(current instanceof Error)) {
            lines.push(`${depth === 0 ? "Error" : "Caused by"}: ${String(current)}`);
            break;
        }

        const metadata = current as ErrorMetadata;
        lines.push(`${depth === 0 ? "Error" : "Caused by"}: ${current.message}`);
        if (metadata.code !== undefined) {
            lines.push(`  Code: ${String(metadata.code)}`);
        }
        if (isRecord(metadata.details) && Object.keys(metadata.details).length > 0) {
            lines.push(`  Details: ${safeJson(metadata.details)}`);
        }
        current = metadata.cause;
        depth += 1;
    }

    if (current !== undefined && depth >= MAXIMUM_CAUSE_DEPTH) {
        lines.push("Caused by: [additional causes omitted]");
    }
    return lines.join("\n");
}

function safeJson(value: Readonly<Record<string, unknown>>): string {
    try {
        return JSON.stringify(value);
    } catch {
        return "[details could not be serialized]";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
