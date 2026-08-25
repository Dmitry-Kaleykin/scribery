import type { StoredChunk, StorageProvider } from "../../storage/index.js";
import type {
    RetrievalContext,
    RetrievalContextChunk,
    RetrievalRequest,
    RetrievalResult,
} from "../contracts/retrieval.js";
import { RetrievalError } from "../errors/retrieval-error.js";

export interface ResolvedContextOptions {
    beforeChunks: number;
    afterChunks: number;
    maximumCharacters: number;
}

export async function expandResultContexts(
    storage: StorageProvider,
    request: RetrievalRequest,
    results: readonly RetrievalResult[],
    options: ResolvedContextOptions,
): Promise<readonly RetrievalResult[]> {
    const primaryChunkKeys = new Set(results.map(({ documentId, chunkId }) =>
        chunkKey(documentId, chunkId)
    ));

    return Promise.all(results.map(async (result) => {
        throwIfCancelled(request.signal);
        const neighborhood = await storage.getChunkNeighborhood({
            repositoryId: request.repositoryId,
            snapshotId: request.snapshotId,
            indexBuildId: request.indexBuildId,
            documentId: result.documentId,
            anchorChunkId: result.chunkId,
            beforeChunks: options.beforeChunks,
            afterChunks: options.afterChunks,
        });
        throwIfCancelled(request.signal);

        return {
            ...result,
            context: selectContext(
                result.documentId,
                neighborhood.before,
                neighborhood.after,
                primaryChunkKeys,
                options.maximumCharacters,
            ),
        };
    }));
}

function selectContext(
    documentId: string,
    before: readonly StoredChunk[],
    after: readonly StoredChunk[],
    primaryChunkKeys: ReadonlySet<string>,
    maximumCharacters: number,
): RetrievalContext {
    const selectedBefore: RetrievalContextChunk[] = [];
    const selectedAfter: RetrievalContextChunk[] = [];
    const selectedChunkIds = new Set<string>();
    let remainingCharacters = maximumCharacters;
    const maximumDistance = Math.max(before.length, after.length);

    for (let distance = 0; distance < maximumDistance; distance += 1) {
        const preceding = before[before.length - 1 - distance];
        const following = after[distance];

        if (preceding !== undefined) {
            includeChunk(preceding, selectedBefore);
        }

        if (following !== undefined) {
            includeChunk(following, selectedAfter);
        }
    }

    return {
        before: selectedBefore.sort(compareContextChunks),
        after: selectedAfter.sort(compareContextChunks),
    };

    function includeChunk(
        chunk: StoredChunk,
        destination: RetrievalContextChunk[],
    ): void {
        if (
            primaryChunkKeys.has(chunkKey(documentId, chunk.metadata.chunkId)) ||
            selectedChunkIds.has(chunk.metadata.chunkId) ||
            chunk.content.length > remainingCharacters
        ) {
            return;
        }

        destination.push(toContextChunk(chunk));
        selectedChunkIds.add(chunk.metadata.chunkId);
        remainingCharacters -= chunk.content.length;
    }
}

function toContextChunk(chunk: StoredChunk): RetrievalContextChunk {
    return {
        chunkId: chunk.metadata.chunkId,
        index: chunk.metadata.index,
        content: chunk.content,
        range: {
            startOffset: chunk.metadata.startOffset,
            endOffset: chunk.metadata.endOffset,
            startLine: chunk.metadata.startLine,
            endLine: chunk.metadata.endLine,
        },
        ...(chunk.metadata.kind === undefined ? {} : { kind: chunk.metadata.kind }),
        ...(chunk.metadata.semanticContext === undefined
            ? {}
            : { semanticContext: chunk.metadata.semanticContext }),
    };
}

function compareContextChunks(
    left: RetrievalContextChunk,
    right: RetrievalContextChunk,
): number {
    return left.index - right.index || compareText(left.chunkId, right.chunkId);
}

function chunkKey(documentId: string, chunkId: string): string {
    return `${documentId}\0${chunkId}`;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new RetrievalError(
            "cancelled",
            "Retrieval was cancelled",
            {},
            signal.reason,
        );
    }
}
