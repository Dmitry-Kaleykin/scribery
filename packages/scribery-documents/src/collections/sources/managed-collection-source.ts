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
    CollectionManifest,
} from "../contracts/collection.js";
import { CollectionError } from "../errors/collection-error.js";
import { CollectionCatalog } from "../managed/catalog.js";

export interface ManagedCollectionSourceRequest {
    manifest: CollectionManifest;
    signal?: AbortSignal;
}

export class ManagedCollectionSourceProvider
    implements SourceSnapshotProvider<ManagedCollectionSourceRequest> {
    readonly #catalog: CollectionCatalog;

    constructor(catalog: CollectionCatalog) {
        this.#catalog = catalog;
    }

    async prepare(
        request: ManagedCollectionSourceRequest,
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
                    throw new CollectionError(
                        "collection-storage-failure",
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
                `collection:${manifest.collectionId}`,
            ),
            rootIdentity: ".",
            sourceIdentity: `managed-collection:${membershipHash}`,
            sourceSelectionHash: hashText(manifest.collectionId),
            provenance: {
                kind: "managed-collection",
                collectionId: manifest.collectionId,
            },
            documents,
            diagnostics: [],
        };
    }
}

function formatFromMediaType(mediaType: string): string {
    return mediaType === "text/markdown" ? "markdown" : "plain-text";
}
