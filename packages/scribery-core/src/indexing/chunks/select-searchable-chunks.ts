import type { Chunk } from "../../chunking/index.js";

export function selectSearchableChunks(
    chunks: readonly Chunk[],
): readonly Chunk[] {
    return chunks.filter(({ content, searchable }) =>
        searchable !== false && content.trim().length > 0
    );
}
