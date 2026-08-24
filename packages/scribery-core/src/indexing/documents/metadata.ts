import type { DefaultFileClassifier } from "../../classification/index.js";
import {
    METADATA_SCHEMA_VERSION,
    hashText,
    type DocumentMetadata,
} from "../../metadata/index.js";
import type { SupportedEncoding } from "../../shared/index.js";
import type {
    PreparedSourceDocument,
} from "../../sources/contracts/source.js";

export function createPreparedDocumentMetadata(
    documentId: string,
    fileRevisionId: string,
    path: string,
    document: PreparedSourceDocument,
    content: string,
    encoding: SupportedEncoding,
    classification: ReturnType<DefaultFileClassifier["classify"]>,
    language: string,
    format: string,
    parserId: string | undefined,
): DocumentMetadata {
    const extension = extensionOf(path);
    return {
        schemaVersion: METADATA_SCHEMA_VERSION,
        documentId,
        fileRevisionId,
        path,
        filename: path.slice(path.lastIndexOf("/") + 1),
        ...(extension === undefined ? {} : { extension }),
        byteLength: document.bytes.byteLength,
        byteContentHash: document.byteContentHash,
        decodedContentHash: hashText(content),
        contentKind: classification.contentKind,
        language,
        format,
        ...(parserId === undefined ? {} : { parserId }),
        encoding,
        traits: classification.traits,
        classificationConfidence: classification.confidence,
        ...(document.sourceId === undefined
            ? {}
            : { sourceId: document.sourceId }),
        ...(document.title === undefined ? {} : { title: document.title }),
        ...(document.mediaType === undefined
            ? {}
            : { mediaType: document.mediaType }),
        ...(document.tags === undefined || document.tags.length === 0
            ? {}
            : { tags: document.tags }),
        ...(document.attributes === undefined ||
                Object.keys(document.attributes).length === 0
            ? {}
            : { sourceAttributes: document.attributes }),
    };
}

export function createPreparedDocumentFilterMetadata(
    document: PreparedSourceDocument,
    path: string,
    language: string,
    format: string,
    traits: readonly string[],
    chunkingStrategy: string,
    chunkKind: string | undefined,
) {
    return {
        path,
        language,
        format,
        extension: extensionOf(path) ?? "",
        traits,
        chunkingStrategy,
        ...(document.sourceId === undefined
            ? {}
            : { sourceId: document.sourceId }),
        ...(document.tags === undefined || document.tags.length === 0
            ? {}
            : { tags: document.tags }),
        ...(chunkKind === undefined ? {} : { chunkKind }),
    };
}

function extensionOf(path: string): string | undefined {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    const dot = filename.lastIndexOf(".");
    return dot <= 0 || dot === filename.length - 1
        ? undefined
        : filename.slice(dot + 1).toLowerCase();
}

