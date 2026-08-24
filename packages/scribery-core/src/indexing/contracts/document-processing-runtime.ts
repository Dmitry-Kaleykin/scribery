import type {
    CodeParserAdapter,
    ChunkingStrategy,
    ParserTarget,
} from "../../chunking/index.js";
import type { FileClassifier } from "../../classification/index.js";
import type { DocumentDecoder } from "../../decoding/index.js";

export interface DocumentProcessingRuntimeOptions {
    slidingWindowOverlap: number;
}

export interface DocumentParserRegistry {
    parserIds(): readonly string[];
    resolve(target: ParserTarget): CodeParserAdapter | undefined;
}

/**
 * Product-owned composition used by the core index build orchestration.
 *
 * The identity must change whenever the classifier, decoder, parser set, or
 * chunking strategy implementations can produce different stored artifacts.
 */
export interface DocumentProcessingRuntime {
    readonly identity: string;
    readonly classifier: FileClassifier;
    readonly decoder: DocumentDecoder;
    readonly parserRegistry: DocumentParserRegistry;

    createChunkingStrategies(
        options: DocumentProcessingRuntimeOptions,
    ): readonly ChunkingStrategy[];
}
