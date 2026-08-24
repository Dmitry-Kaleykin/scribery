import {
    CastChunkingStrategy,
    DefaultDocumentDecoder,
    DefaultFileClassifier,
    createInitialParserRegistry,
    type DocumentProcessingRuntime,
} from "scribery-core";

export const CODE_PROCESSING_RUNTIME_IDENTITY =
    "scribery-code:document-processing-v1";

export function createCodeProcessingRuntime(): DocumentProcessingRuntime {
    const parserRegistry = createInitialParserRegistry();

    return {
        identity: CODE_PROCESSING_RUNTIME_IDENTITY,
        classifier: new DefaultFileClassifier(),
        decoder: new DefaultDocumentDecoder(),
        parserRegistry,
        createChunkingStrategies: () => [
            new CastChunkingStrategy(parserRegistry),
        ],
    };
}
