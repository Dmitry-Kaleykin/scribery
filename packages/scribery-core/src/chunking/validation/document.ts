import type { ChunkingDocument } from "../contracts/chunk.js";
import { ChunkingError } from "../errors/chunking-error.js";

export function validateChunkingDocument(document: ChunkingDocument): void {
    if (typeof document.path !== "string" || document.path.trim().length === 0) {
        throw new ChunkingError(
            "invalid-document",
            "Chunking document path must not be empty",
        );
    }

    if (typeof document.content !== "string" || document.content.length === 0) {
        throw new ChunkingError(
            "invalid-document",
            `Chunking document ${document.path} must contain decoded source text`,
            { path: document.path },
        );
    }

    if (
        typeof document.language !== "string" ||
        document.language.trim().length === 0 ||
        document.language !== document.language.trim().toLowerCase()
    ) {
        throw new ChunkingError(
            "invalid-document",
            `Chunking document ${document.path} must have a canonical language`,
            { path: document.path },
        );
    }

    if (
        document.format !== undefined &&
        (typeof document.format !== "string" ||
            document.format.trim().length === 0 ||
            document.format !== document.format.trim().toLowerCase())
    ) {
        throw new ChunkingError(
            "invalid-document",
            `Chunking document ${document.path} must have a canonical format`,
            { path: document.path },
        );
    }
}
