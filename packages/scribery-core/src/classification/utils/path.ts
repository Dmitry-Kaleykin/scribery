export function normalizeClassificationPath(path: string): string {
    return path.replaceAll("\\", "/");
}

export function getClassificationFilename(path: string): string {
    const normalizedPath = normalizeClassificationPath(path);
    return normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
}

export function getClassificationExtension(path: string): string | undefined {
    const filename = getClassificationFilename(path);
    const lastDot = filename.lastIndexOf(".");

    if (lastDot <= 0 || lastDot === filename.length - 1) {
        return undefined;
    }

    return filename.slice(lastDot + 1).toLowerCase();
}
