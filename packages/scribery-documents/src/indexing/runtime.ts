import {
    CastChunkingStrategy,
    DefaultDocumentDecoder,
    DefaultFileClassifier,
    SlidingWindowChunkingStrategy,
    createInitialParserRegistry,
    type DocumentProcessingRuntime,
} from "scribery-core";

export const DOCUMENTS_PROCESSING_RUNTIME_IDENTITY =
    "scribery-documents:document-processing-v1";

export function createDocumentsProcessingRuntime(): DocumentProcessingRuntime {
    const parserRegistry = createInitialParserRegistry();

    return {
        identity: DOCUMENTS_PROCESSING_RUNTIME_IDENTITY,
        classifier: new DefaultFileClassifier(),
        decoder: new DefaultDocumentDecoder(),
        parserRegistry,
        createChunkingStrategies: ({ slidingWindowOverlap }) => [
            new CastChunkingStrategy(parserRegistry),
            new SlidingWindowChunkingStrategy({
                overlapSize: slidingWindowOverlap,
            }),
        ],
    };
}
