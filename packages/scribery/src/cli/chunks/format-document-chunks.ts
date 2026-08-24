import type { DocumentChunks } from "scribery-core";

export function formatDocumentChunks(
    indexBuildId: string,
    result: DocumentChunks,
): string {
    const { metadata } = result.document;
    let output = [
        `File: ${metadata.path}`,
        `Build: ${indexBuildId}`,
        `Language: ${metadata.language} (${metadata.format})`,
        `Encoding: ${metadata.encoding}`,
        `Chunks: ${result.chunks.length}`,
        "",
    ].join("\n");

    for (let position = 0; position < result.chunks.length; position += 1) {
        const chunk = result.chunks[position]!;
        const kind = chunk.metadata.kind ?? "mixed";
        output += `--- Chunk ${position + 1}/${result.chunks.length}` +
            ` | index=${chunk.metadata.index}` +
            ` | kind=${kind}` +
            ` | lines=${chunk.metadata.startLine}-${chunk.metadata.endLine}` +
            ` | offsets=${chunk.metadata.startOffset}-${chunk.metadata.endOffset}` +
            " ---\n";
        output += chunk.content;

        if (!chunk.content.endsWith("\n")) {
            output += "\n";
        }

        output += "\n";
    }

    return output;
}

export function serializeDocumentChunks(
    indexBuildId: string,
    result: DocumentChunks,
): object {
    return {
        indexBuildId,
        path: result.document.metadata.path,
        document: { metadata: result.document.metadata },
        chunkCount: result.chunks.length,
        chunks: result.chunks,
    };
}
