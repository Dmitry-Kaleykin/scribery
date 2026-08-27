import {
    createRepositoryId,
    hashBytes,
    hashText,
} from "scribery-core";
import type {
    PreparedSourceSnapshot,
    SourceSnapshotProvider,
} from "scribery-core";
import type {
    DocumentationManifest,
} from "../contracts/documentation.js";
import { DocumentationError } from "../errors/documentation-error.js";
import { DocumentationCatalog } from "../managed/catalog.js";

export interface ManagedDocumentationSourceRequest {
    manifest: DocumentationManifest;
    signal?: AbortSignal;
}

export class ManagedDocumentationSourceProvider
    implements SourceSnapshotProvider<ManagedDocumentationSourceRequest> {
    readonly #catalog: DocumentationCatalog;

    constructor(catalog: DocumentationCatalog) {
        this.#catalog = catalog;
    }

    async prepare(
        request: ManagedDocumentationSourceRequest,
    ): Promise<PreparedSourceSnapshot> {
        const { manifest } = request;
        const documents = await Promise.all(
            manifest.sources.map(async (source) => {
                request.signal?.throwIfAborted();
                const bytes = await this.#catalog.readSourceContent(
                    manifest,
                    source,
                );

                if (hashBytes(bytes) !== source.byteContentHash) {
                    throw new DocumentationError(
                        "documentation-storage-failure",
                        `Stored content for ${source.sourceId} does not match its manifest`,
                        { sourceId: source.sourceId },
                    );
                }

                return {
                    path: source.logicalPath,
                    bytes,
                    byteContentHash: source.byteContentHash,
                    revisionIdentity: hashText(JSON.stringify({
                        byteContentHash: source.byteContentHash,
                        logicalPath: source.logicalPath,
                        title: source.title,
                        mediaType: source.mediaType,
                        tags: source.tags,
                        attributes: source.attributes,
                        encoding: source.encoding ?? null,
                    })),
                    ...(source.encoding === undefined
                        ? {}
                        : { encoding: source.encoding }),
                    fallbackFormat: formatFromMediaType(source.mediaType),
                    sourceId: source.sourceId,
                    title: source.title,
                    mediaType: source.mediaType,
                    tags: source.tags,
                    attributes: source.attributes,
                };
            }),
        );
        const membershipHash = hashText(JSON.stringify(
            manifest.sources.map((source) => ({
                sourceId: source.sourceId,
                logicalPath: source.logicalPath,
                byteContentHash: source.byteContentHash,
                title: source.title,
                mediaType: source.mediaType,
                tags: source.tags,
                attributes: source.attributes,
                encoding: source.encoding ?? null,
            })),
        ));

        return {
            scopeId: createRepositoryId(
                `documentation:${manifest.documentationId}`,
            ),
            rootIdentity: ".",
            sourceIdentity: `managed-documentation:${membershipHash}`,
            sourceSelectionHash: hashText(manifest.documentationId),
            provenance: {
                kind: "managed-documentation",
                documentationId: manifest.documentationId,
            },
            documents,
            diagnostics: [],
        };
    }
}

function formatFromMediaType(mediaType: string): string {
    return mediaType === "text/markdown" ? "markdown" : "plain-text";
}
