import { extname } from "node:path";

export function mediaTypeFromPath(path: string): string {
    switch (extname(path).toLowerCase()) {
        case ".md":
        case ".markdown":
            return "text/markdown";
        case ".json":
            return "application/json";
        case ".html":
        case ".htm":
            return "text/html";
        default:
            return "text/plain";
    }
}
