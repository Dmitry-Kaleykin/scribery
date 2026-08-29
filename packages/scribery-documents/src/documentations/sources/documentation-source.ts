import { basename, extname, join } from "node:path";

import {
    createRepositoryId,
    createSourceId,
    DirectorySourceProvider,
    hashBytes,
    hashText,
    normalizeRelativePath,
    type PreparedSourceDocument,
    type PreparedSourceSnapshot,
    type SourceDiagnostic,
} from "scribery-core";
import type {
    DirectoryDocumentationSource,
    DocumentationManifest,
    DocumentationSourceDefinition,
    IndexedDocumentationSource,
    ManagedDocumentationSource,
} from "../contracts/documentation.js";
import { DocumentationError } from "../errors/documentation-error.js";
import { DocumentationCatalog } from "../managed/catalog.js";

export interface DocumentationSourceRequest {
    manifest: DocumentationManifest;
    signal?: AbortSignal;
}

export interface PreparedDocumentationSnapshot {
    source: PreparedSourceSnapshot;
    indexedSources: readonly IndexedDocumentationSource[];
}

export class DocumentationSourceProvider {
    readonly #catalog: DocumentationCatalog;
    readonly #directories: DirectorySourceProvider;

    constructor(
        catalog: DocumentationCatalog,
        directories = new DirectorySourceProvider(),
    ) {
        this.#catalog = catalog;
        this.#directories = directories;
    }

    async prepare(request: DocumentationSourceRequest): Promise<PreparedDocumentationSnapshot> {
        const documents: PreparedSourceDocument[] = [];
        const indexedSources: IndexedDocumentationSource[] = [];
        const diagnostics: SourceDiagnostic[] = [];
        const seenPaths = new Map<string, string>();

        for (const definition of request.manifest.sourceDefinitions) {
            request.signal?.throwIfAborted();
            const prepared = definition.kind === "directory"
                ? await this.#prepareDirectory(request.manifest, definition, request.signal)
                : await this.#prepareManaged(request.manifest, definition, request.signal);

            for (let index = 0; index < prepared.documents.length; index += 1) {
                const document = prepared.documents[index]!;
                const indexedSource = prepared.indexedSources[index]!;
                const conflictingSourceId = seenPaths.get(document.path);
                if (conflictingSourceId !== undefined) {
                    throw new DocumentationError(
                        "source-conflict",
                        `Indexed path ${document.path} is produced by more than one source`,
                        {
                            logicalPath: document.path,
                            sourceId: indexedSource.sourceId,
                            conflictingSourceId,
                        },
                    );
                }
                seenPaths.set(document.path, indexedSource.sourceId);
                documents.push(document);
                indexedSources.push(indexedSource);
            }
            diagnostics.push(...prepared.diagnostics);
        }

        const ordered = documents
            .map((document, index) => ({ document, indexedSource: indexedSources[index]! }))
            .sort((left, right) => left.document.path.localeCompare(right.document.path));
        const sortedDocuments = ordered.map(({ document }) => document);
        const sortedIndexedSources = ordered.map(({ indexedSource }) => indexedSource);
        const membershipHash = hashText(JSON.stringify(sortedDocuments.map((document) => ({
            path: document.path,
            byteContentHash: document.byteContentHash,
            revisionIdentity: document.revisionIdentity,
        }))));

        return {
            source: {
                scopeId: createRepositoryId(
                    `documentation:${request.manifest.documentationId}`,
                ),
                rootIdentity: ".",
                sourceIdentity: `documentation:${membershipHash}`,
                sourceSelectionHash: hashText(JSON.stringify(
                    request.manifest.sourceDefinitions.map(sourceConfigurationIdentity),
                )),
                provenance: {
                    kind: "managed-documentation",
                    documentationId: request.manifest.documentationId,
                },
                documents: sortedDocuments,
                diagnostics,
            },
            indexedSources: sortedIndexedSources,
        };
    }

    async #prepareDirectory(
        manifest: DocumentationManifest,
        definition: DirectoryDocumentationSource,
        signal: AbortSignal | undefined,
    ): Promise<PreparedDefinition> {
        const snapshot = await this.#directories.prepare({
            root: definition.root,
            repositoryIdentity: `documentation:${manifest.documentationId}:${definition.sourceId}`,
            discoveryOptions: {
                include: definition.include,
                exclude: definition.exclude,
                useGitignore: definition.useGitignore,
                includeHidden: definition.includeHidden,
                ...(definition.maximumFileByteLength === undefined
                    ? {}
                    : { maxFileSize: definition.maximumFileByteLength }),
            },
            ...(signal === undefined ? {} : { signal }),
        });
        const documents = snapshot.documents.map((document) => {
            const path = mountedPath(definition.mountPath, document.path);
            const sourceId = createSourceId(
                manifest.documentationId,
                `${definition.sourceId}:${document.path}`,
            );
            const title = basename(document.path);
            const mediaType = mediaTypeFromPath(document.path);
            return {
                ...document,
                path,
                revisionIdentity: hashText(JSON.stringify({
                    revisionIdentity: document.revisionIdentity,
                    path,
                    title,
                    mediaType,
                    tags: definition.tags,
                    attributes: definition.attributes,
                })),
                sourceId,
                title,
                mediaType,
                tags: definition.tags,
                attributes: definition.attributes,
            };
        });
        return {
            documents,
            indexedSources: documents.map((document) => ({
                sourceId: document.sourceId,
                sourceDefinitionId: definition.sourceId,
                logicalPath: document.path,
                title: document.title,
                byteLength: document.bytes.byteLength,
                byteContentHash: document.byteContentHash,
                tags: definition.tags,
                attributes: definition.attributes,
                originalLocation: join(definition.root, relativeFromMount(
                    definition.mountPath,
                    document.path,
                )),
                mediaType: document.mediaType,
            })),
            diagnostics: snapshot.diagnostics.map((diagnostic) => ({
                ...diagnostic,
                path: mountedPath(definition.mountPath, diagnostic.path),
            })),
        };
    }

    async #prepareManaged(
        manifest: DocumentationManifest,
        definition: ManagedDocumentationSource,
        signal: AbortSignal | undefined,
    ): Promise<PreparedDefinition> {
        signal?.throwIfAborted();
        const bytes = await this.#catalog.readSourceContent(manifest, definition);
        if (hashBytes(bytes) !== definition.byteContentHash) {
            throw new DocumentationError(
                "documentation-storage-failure",
                `Stored content for ${definition.sourceId} does not match its manifest`,
                { sourceId: definition.sourceId },
            );
        }
        const document: PreparedSourceDocument = {
            path: definition.logicalPath,
            bytes,
            byteContentHash: definition.byteContentHash,
            revisionIdentity: hashText(JSON.stringify({
                byteContentHash: definition.byteContentHash,
                logicalPath: definition.logicalPath,
                title: definition.title,
                mediaType: definition.mediaType,
                tags: definition.tags,
                attributes: definition.attributes,
                encoding: definition.encoding ?? null,
            })),
            ...(definition.encoding === undefined ? {} : { encoding: definition.encoding }),
            fallbackFormat: formatFromMediaType(definition.mediaType),
            sourceId: definition.sourceId,
            title: definition.title,
            mediaType: definition.mediaType,
            tags: definition.tags,
            attributes: definition.attributes,
        };
        return {
            documents: [document],
            indexedSources: [{
                sourceId: definition.sourceId,
                sourceDefinitionId: definition.sourceId,
                logicalPath: definition.logicalPath,
                title: definition.title,
                byteLength: definition.byteLength,
                byteContentHash: definition.byteContentHash,
                tags: definition.tags,
                attributes: definition.attributes,
                ...(definition.originalLocation === undefined
                    ? {}
                    : { originalLocation: definition.originalLocation }),
                mediaType: definition.mediaType,
                ...(definition.encoding === undefined ? {} : { encoding: definition.encoding }),
            }],
            diagnostics: [],
        };
    }
}

interface PreparedDefinition {
    documents: readonly PreparedSourceDocument[];
    indexedSources: readonly IndexedDocumentationSource[];
    diagnostics: readonly SourceDiagnostic[];
}

function mountedPath(mountPath: string, path: string): string {
    return normalizeRelativePath(`${mountPath}/${path}`);
}

function relativeFromMount(mountPath: string, path: string): string {
    return path.slice(mountPath.length + 1);
}

function sourceConfigurationIdentity(source: DocumentationSourceDefinition): unknown {
    if (source.kind === "directory") {
        return {
            kind: source.kind,
            sourceId: source.sourceId,
            root: source.root,
            mountPath: source.mountPath,
            include: source.include,
            exclude: source.exclude,
            useGitignore: source.useGitignore,
            includeHidden: source.includeHidden,
            maximumFileByteLength: source.maximumFileByteLength ?? null,
            tags: source.tags,
            attributes: source.attributes,
        };
    }
    return {
        kind: source.kind,
        sourceId: source.sourceId,
        logicalPath: source.logicalPath,
        mediaType: source.mediaType,
        encoding: source.encoding ?? null,
        tags: source.tags,
        attributes: source.attributes,
    };
}

function formatFromMediaType(mediaType: string): string {
    return mediaType === "text/markdown" ? "markdown" : "plain-text";
}

function mediaTypeFromPath(path: string): string {
    const extension = extname(path).toLowerCase();
    return ({
        ".css": "text/css",
        ".csv": "text/csv",
        ".html": "text/html",
        ".htm": "text/html",
        ".js": "text/javascript",
        ".json": "application/json",
        ".jsx": "text/javascript",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".mjs": "text/javascript",
        ".py": "text/x-python",
        ".ts": "text/typescript",
        ".tsx": "text/typescript",
        ".txt": "text/plain",
        ".xml": "application/xml",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
    } as Readonly<Record<string, string>>)[extension] ?? "application/octet-stream";
}
