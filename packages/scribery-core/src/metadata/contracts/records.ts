import type { ContentKind, FileTrait } from "../../classification/index.js";
import type { SupportedEncoding } from "../../shared/index.js";
import type { SourceRange } from "./source-position.js";
import type { ChunkSemanticContext } from "./code-context.js";

export interface DocumentMetadata {
    schemaVersion: number;
    documentId: string;
    fileRevisionId: string;
    path: string;
    filename: string;
    extension?: string;
    byteLength: number;
    byteContentHash: string;
    decodedContentHash: string;
    contentKind: ContentKind;
    format: string;
    language: string;
    encoding: SupportedEncoding;
    traits: readonly FileTrait[];
    classificationConfidence: number;
    parserId?: string;
    sourceId?: string;
    title?: string;
    mediaType?: string;
    tags?: readonly string[];
    sourceAttributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ChunkMetadata extends SourceRange {
    schemaVersion: number;
    chunkId: string;
    fileRevisionId: string;
    documentId: string;
    index: number;
    contentHash: string;
    chunkingStrategy: string;
    chunkingIdentity: string;
    kind?: string;
    semanticContext?: ChunkSemanticContext;
}

export type FilterValue = string | number | boolean;
export type FilterMetadata = Readonly<
    Record<string, FilterValue | readonly FilterValue[]>
>;
