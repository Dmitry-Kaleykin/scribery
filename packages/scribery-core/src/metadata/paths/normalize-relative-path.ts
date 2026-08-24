import { MetadataError } from "../errors/metadata-error.js";

export function normalizeRelativePath(path: string): string {
    if (typeof path !== "string" || path.trim().length === 0) {
        throw invalidPath(path, "Metadata path must not be empty");
    }

    const slashPath = path.replaceAll("\\", "/");

    if (slashPath.startsWith("/") || /^[a-z]:\//iu.test(slashPath)) {
        throw invalidPath(path, "Metadata path must be relative");
    }

    const segments: string[] = [];

    for (const segment of slashPath.split("/")) {
        if (segment.length === 0 || segment === ".") {
            continue;
        }

        if (segment === "..") {
            throw invalidPath(path, "Metadata path must not escape its root");
        }

        segments.push(segment);
    }

    if (segments.length === 0) {
        throw invalidPath(path, "Metadata path must identify a file");
    }

    return segments.join("/");
}

function invalidPath(path: unknown, message: string): MetadataError {
    return new MetadataError("invalid-path", message, { path });
}
