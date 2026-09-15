import type { CompressionExcerpt, CompressionDiagnostic } from "./contracts.js";
import type { RetrievalResult } from "../retrieval/contracts/retrieval.js";

export type CompressedRetrievalDocument = Omit<RetrievalResult,
    "content" | "range" | "chunkId" | "score" | "semanticScore" | "rerankScore" |
    "semanticContext" | "kind" | "context" | "compression"
> & {
    matchedChunks: Array<Pick<RetrievalResult, "chunkId" | "range" | "score" | "semanticScore" | "rerankScore">>;
    excerpts: readonly CompressionExcerpt[];
    compression: CompressionDiagnostic;
};

/** Keep full matches inside retrieval; expose selected source only at transport boundaries. */
export function presentRetrievalResults(results: readonly RetrievalResult[]) {
    const seen = new Set<string>();
    return results.flatMap<RetrievalResult | CompressedRetrievalDocument>((result) => {
        if (result.compression?.diagnostic.status !== "selected") return [result];
        const key = `${result.indexBuildId}\0${result.documentId}`;
        if (seen.has(key)) return [];
        seen.add(key);
        const {
            content: _content, range: _range, chunkId: _chunkId,
            score: _score, semanticScore: _semanticScore, rerankScore: _rerankScore,
            semanticContext: _semanticContext, kind: _kind, context: _context,
            compression, ...document
        } = result;
        return [{
            ...document,
            matchedChunks: results.filter((match) => match.documentId === result.documentId && match.indexBuildId === result.indexBuildId)
                .map(({ chunkId, range, score, semanticScore, rerankScore }) => ({
                    chunkId, range, score,
                    ...(semanticScore === undefined ? {} : { semanticScore }),
                    ...(rerankScore === undefined ? {} : { rerankScore }),
                })),
            excerpts: compression.excerpts,
            compression: compression.diagnostic,
        }];
    });
}
