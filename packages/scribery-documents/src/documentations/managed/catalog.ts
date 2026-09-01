import {
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
    createDocumentationId,
    createSourceId,
    hashBytes,
    normalizeRelativePath,
} from "scribery-core";
import { DOCUMENTATION_MANIFEST_VERSION } from "../constants/storage.js";
import type {
    DirectoryDocumentationSource,
    DocumentationDirectoryInput,
    DocumentationInput,
    DocumentationManifest,
    DocumentationSourceDefinition,
    DocumentationSummary,
    DeletedDocumentation,
    ManagedDocumentationSource,
    SourceTagMutation,
} from "../contracts/documentation.js";
import { DocumentationError } from "../errors/documentation-error.js";
import {
    documentationDatabasePath,
    documentationDirectory,
    documentationManifestPath,
    documentationSourcePath,
    managedDocumentationsDirectory,
    validateDocumentationId,
} from "./paths.js";

export class DocumentationCatalog {
    readonly baseDirectory: string;

    constructor(baseDirectory = managedDocumentationsDirectory()) {
        this.baseDirectory = baseDirectory;
    }

    async create(
        name: string,
        description?: string,
    ): Promise<DocumentationManifest> {
        const normalizedName = normalizeDocumentationName(name);
        const normalizedDescription = normalizeDocumentationDescription(description);
        const documentationId = createDocumentationId(normalizedName.toLowerCase());

        if (await this.#readById(documentationId) !== undefined) {
            throw new DocumentationError(
                "documentation-exists",
                `Documentation ${normalizedName} already exists`,
                { documentationId },
            );
        }

        const now = new Date().toISOString();
        const manifest: DocumentationManifest = {
            schemaVersion: DOCUMENTATION_MANIFEST_VERSION,
            documentationId,
            name: normalizedName,
            ...(normalizedDescription === undefined
                ? {}
                : { description: normalizedDescription }),
            createdAt: now,
            updatedAt: now,
            configurationRevision: 0,
            sourceDefinitions: [],
        };
        await this.write(manifest);
        return manifest;
    }

    async resolve(reference: string): Promise<DocumentationManifest> {
        const trimmed = reference.trim();
        const direct = trimmed.startsWith("documentation_")
            ? await this.#readById(trimmed)
            : undefined;
        if (direct !== undefined) return direct;

        const matches = (await this.list()).filter(({ name }) =>
            name.toLowerCase() === trimmed.toLowerCase()
        );
        if (matches.length !== 1) {
            throw new DocumentationError(
                "documentation-not-found",
                `Documentation ${reference} was not found`,
                { reference },
            );
        }

        const manifest = await this.#readById(matches[0]!.documentationId);
        if (manifest === undefined) {
            throw new DocumentationError(
                "documentation-not-found",
                `Documentation ${reference} was not found`,
            );
        }
        return manifest;
    }

    async list(): Promise<readonly DocumentationSummary[]> {
        let entries: string[];
        try {
            entries = await readdir(this.baseDirectory);
        } catch (error: unknown) {
            if (isMissing(error)) return [];
            throw error;
        }

        const summaries: DocumentationSummary[] = [];
        for (const entry of entries.sort()) {
            const manifest = await this.#readById(entry);
            if (manifest !== undefined) {
                summaries.push(summaryFrom(manifest, this.baseDirectory));
            }
        }
        return summaries.sort((left, right) => left.name.localeCompare(right.name));
    }

    async setDescription(
        reference: string,
        description?: string,
    ): Promise<DocumentationManifest> {
        const manifest = await this.resolve(reference);
        const normalizedDescription = normalizeDocumentationDescription(description);
        if (manifest.description === normalizedDescription) return manifest;

        const updated: DocumentationManifest = {
            ...manifest,
            updatedAt: new Date().toISOString(),
        };
        if (normalizedDescription === undefined) {
            delete updated.description;
        } else {
            updated.description = normalizedDescription;
        }
        await this.write(updated);
        return updated;
    }

    async delete(reference: string): Promise<DeletedDocumentation> {
        const manifest = await this.resolve(reference);
        const databasePath = documentationDatabasePath(
            this.baseDirectory,
            manifest.documentationId,
        );
        try {
            await rm(documentationDirectory(this.baseDirectory, manifest.documentationId), {
                recursive: true,
            });
        } catch (error: unknown) {
            throw new DocumentationError(
                "documentation-storage-failure",
                `Documentation ${manifest.name} could not be deleted`,
                { documentationId: manifest.documentationId },
                error,
            );
        }
        return { documentationId: manifest.documentationId, name: manifest.name, databasePath };
    }

    async addDirectorySource(
        reference: string,
        input: DocumentationDirectoryInput,
    ): Promise<DocumentationManifest> {
        const manifest = await this.resolve(reference);
        const root = await realpath(requiredText(input.root, "directory root"));
        if (!(await stat(root)).isDirectory()) {
            throw new DocumentationError(
                "invalid-documentation",
                `Documentation directory source is not a directory: ${root}`,
                { root },
            );
        }
        const sourceId = createSourceId(manifest.documentationId, `directory:${root}`);
        const previous = manifest.sourceDefinitions.find(({ sourceId: id }) => id === sourceId);
        if (previous !== undefined && previous.kind !== "directory") {
            throw new DocumentationError("source-conflict", "Source identifier is already in use", {
                sourceId,
            });
        }

        const mountPath = normalizeRelativePath(
            input.mountPath ?? previous?.mountPath ?? basename(root),
        );
        const conflict = manifest.sourceDefinitions.find((source) =>
            source.sourceId !== sourceId &&
            source.kind === "directory" &&
            source.mountPath === mountPath
        );
        if (conflict !== undefined) {
            throw new DocumentationError(
                "source-conflict",
                `Mount path ${mountPath} belongs to another directory source`,
                { mountPath, conflictingSourceId: conflict.sourceId },
            );
        }

        const now = new Date().toISOString();
        const source: DirectoryDocumentationSource = {
            kind: "directory",
            sourceId,
            root,
            mountPath,
            include: normalizePatterns(input.include ?? previous?.include ?? []),
            exclude: normalizePatterns(input.exclude ?? previous?.exclude ?? []),
            useGitignore: input.useGitignore ?? previous?.useGitignore ?? true,
            includeHidden: input.includeHidden ?? previous?.includeHidden ?? false,
            ...(normalizeMaximumFileByteLength(
                    input.maximumFileByteLength ?? previous?.maximumFileByteLength,
                ) === undefined
                ? {}
                : {
                    maximumFileByteLength: normalizeMaximumFileByteLength(
                        input.maximumFileByteLength ?? previous?.maximumFileByteLength,
                    )!,
                }),
            tags: normalizeTags(input.tags ?? previous?.tags ?? []),
            attributes: normalizeAttributes(input.attributes ?? previous?.attributes ?? {}),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        if (previous !== undefined && equalSourceDefinitions(previous, source)) return manifest;
        return this.#replaceSourceDefinition(manifest, source, now);
    }

    async upsertDocuments(
        reference: string,
        inputs: readonly DocumentationInput[],
    ): Promise<DocumentationManifest> {
        if (inputs.length === 0) {
            throw new DocumentationError("invalid-documentation", "At least one document is required");
        }

        const manifest = await this.resolve(reference);
        const sources = new Map(manifest.sourceDefinitions.map((source) => [source.sourceId, source]));
        const paths = new Map(
            manifest.sourceDefinitions
                .filter((source): source is ManagedDocumentationSource => source.kind === "managed")
                .map((source) => [source.logicalPath, source.sourceId]),
        );
        const now = new Date().toISOString();
        let changed = false;

        for (const input of inputs) {
            const externalId = requiredText(input.externalId, "externalId");
            const sourceId = createSourceId(manifest.documentationId, `managed:${externalId}`);
            const existing = sources.get(sourceId);
            if (existing !== undefined && existing.kind !== "managed") {
                throw new DocumentationError("source-conflict", "Source identifier is already in use", {
                    sourceId,
                });
            }
            const previous = existing;
            const title = input.title?.trim() || previous?.title || basename(externalId);
            const logicalPath = normalizeRelativePath(
                input.logicalPath ?? previous?.logicalPath ??
                    `sources/${sourceId}/${safeFilename(title)}`,
            );
            const conflictingSourceId = paths.get(logicalPath);
            if (conflictingSourceId !== undefined && conflictingSourceId !== sourceId) {
                throw new DocumentationError(
                    "source-conflict",
                    `Logical path ${logicalPath} belongs to another source`,
                    { logicalPath, conflictingSourceId },
                );
            }

            const bytes = typeof input.content === "string"
                ? Buffer.from(input.content, "utf8")
                : Uint8Array.from(input.content);
            const source: ManagedDocumentationSource = {
                kind: "managed",
                sourceId,
                externalId,
                logicalPath,
                title,
                mediaType: input.mediaType?.trim() || previous?.mediaType || "text/plain",
                byteLength: bytes.byteLength,
                byteContentHash: hashBytes(bytes),
                contentFilename: `${sourceId}.bin`,
                tags: normalizeTags(input.tags ?? previous?.tags ?? []),
                attributes: normalizeAttributes(input.attributes ?? previous?.attributes ?? {}),
                ...(input.originalLocation === undefined
                    ? previous?.originalLocation === undefined
                        ? {}
                        : { originalLocation: previous.originalLocation }
                    : { originalLocation: input.originalLocation }),
                ...(input.encoding === undefined
                    ? previous?.encoding === undefined ? {} : { encoding: previous.encoding }
                    : { encoding: input.encoding }),
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
            };
            const contentPath = documentationSourcePath(
                this.baseDirectory,
                manifest.documentationId,
                source.contentFilename,
            );
            await mkdir(dirname(contentPath), { recursive: true });
            await writeFile(contentPath, bytes);

            if (previous !== undefined && equalSourceDefinitions(previous, source)) continue;
            changed = true;
            if (previous !== undefined && previous.logicalPath !== logicalPath) {
                paths.delete(previous.logicalPath);
            }
            paths.set(logicalPath, sourceId);
            sources.set(sourceId, source);
        }

        if (!changed) return manifest;
        const updated: DocumentationManifest = {
            ...manifest,
            updatedAt: now,
            configurationRevision: manifest.configurationRevision + 1,
            sourceDefinitions: sortSourceDefinitions([...sources.values()]),
        };
        await this.write(updated);
        return updated;
    }

    async removeSourceDefinitions(
        reference: string,
        sourceIds: readonly string[],
    ): Promise<DocumentationManifest> {
        const manifest = await this.resolve(reference);
        const requested = new Set(sourceIds.map((id) => requiredText(id, "sourceId")));
        const found = manifest.sourceDefinitions.filter(({ sourceId }) => requested.has(sourceId));
        if (found.length !== requested.size) {
            const foundIds = new Set(found.map(({ sourceId }) => sourceId));
            throw new DocumentationError("source-not-found", "One or more source definitions were not found", {
                sourceIds: [...requested].filter((id) => !foundIds.has(id)),
            });
        }

        const updated: DocumentationManifest = {
            ...manifest,
            updatedAt: new Date().toISOString(),
            configurationRevision: manifest.configurationRevision + 1,
            sourceDefinitions: manifest.sourceDefinitions.filter(({ sourceId }) => !requested.has(sourceId)),
        };
        await this.write(updated);
        for (const source of found) {
            if (source.kind !== "managed") continue;
            await unlink(documentationSourcePath(
                this.baseDirectory,
                manifest.documentationId,
                source.contentFilename,
            )).catch((error: unknown) => {
                if (!isMissing(error)) throw error;
            });
        }
        return updated;
    }

    async updateSourceTags(
        reference: string,
        sourceIds: readonly string[],
        mutation: SourceTagMutation,
        tags: readonly string[] = [],
    ): Promise<DocumentationManifest> {
        if (sourceIds.length === 0) {
            throw new DocumentationError("invalid-documentation", "At least one source identifier is required");
        }
        const manifest = await this.resolve(reference);
        const requested = new Set(sourceIds.map((id) => requiredText(id, "sourceId")));
        const found = manifest.sourceDefinitions.filter(({ sourceId }) => requested.has(sourceId));
        if (found.length !== requested.size) {
            const foundIds = new Set(found.map(({ sourceId }) => sourceId));
            throw new DocumentationError("source-not-found", "One or more source definitions were not found", {
                sourceIds: [...requested].filter((id) => !foundIds.has(id)),
            });
        }
        if (mutation === "clear" && tags.length > 0) {
            throw new DocumentationError("invalid-documentation", "Source tag clear does not accept tags");
        }
        const normalizedTags = normalizeTags(tags);
        if (mutation !== "clear" && normalizedTags.length === 0) {
            throw new DocumentationError(
                "invalid-documentation",
                `Source tag ${mutation} requires at least one tag`,
            );
        }

        const now = new Date().toISOString();
        let changed = false;
        const sourceDefinitions = manifest.sourceDefinitions.map((source) => {
            if (!requested.has(source.sourceId)) return source;
            const nextTags = mutateTags(source.tags, mutation, normalizedTags);
            if (equalTags(source.tags, nextTags)) return source;
            changed = true;
            return { ...source, tags: nextTags, updatedAt: now };
        });
        if (!changed) return manifest;

        const updated: DocumentationManifest = {
            ...manifest,
            updatedAt: now,
            configurationRevision: manifest.configurationRevision + 1,
            sourceDefinitions,
        };
        await this.write(updated);
        return updated;
    }

    async readSourceContent(
        manifest: DocumentationManifest,
        source: ManagedDocumentationSource,
    ): Promise<Uint8Array> {
        return readFile(documentationSourcePath(
            this.baseDirectory,
            manifest.documentationId,
            source.contentFilename,
        ));
    }

    async write(manifest: DocumentationManifest): Promise<void> {
        const path = documentationManifestPath(this.baseDirectory, manifest.documentationId);
        const temporaryPath = `${path}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        await rename(temporaryPath, path);
    }

    async #replaceSourceDefinition(
        manifest: DocumentationManifest,
        source: DocumentationSourceDefinition,
        now: string,
    ): Promise<DocumentationManifest> {
        const updated: DocumentationManifest = {
            ...manifest,
            updatedAt: now,
            configurationRevision: manifest.configurationRevision + 1,
            sourceDefinitions: sortSourceDefinitions([
                ...manifest.sourceDefinitions.filter(({ sourceId }) => sourceId !== source.sourceId),
                source,
            ]),
        };
        await this.write(updated);
        return updated;
    }

    async #readById(documentationId: string): Promise<DocumentationManifest | undefined> {
        try {
            validateDocumentationId(documentationId);
        } catch {
            return undefined;
        }
        try {
            const parsed = JSON.parse(await readFile(
                documentationManifestPath(this.baseDirectory, documentationId),
                "utf8",
            )) as DocumentationManifest;
            if (!isManifest(parsed)) {
                throw new DocumentationError(
                    "documentation-storage-failure",
                    `Documentation manifest ${documentationId} is invalid`,
                    { documentationId },
                );
            }
            return {
                ...parsed,
                sourceDefinitions: parsed.sourceDefinitions.map((source) => ({
                    ...source,
                    tags: source.tags ?? [],
                    attributes: source.attributes ?? {},
                })),
                ...(parsed.activeBuild === undefined
                    ? {}
                    : {
                        activeBuild: {
                            ...parsed.activeBuild,
                            indexedSources: parsed.activeBuild.indexedSources.map((source) => ({
                                ...source,
                                tags: source.tags ?? [],
                                attributes: source.attributes ?? {},
                            })),
                        },
                    }),
            };
        } catch (error: unknown) {
            if (isMissing(error)) return undefined;
            if (error instanceof DocumentationError) throw error;
            throw new DocumentationError(
                "documentation-storage-failure",
                `Documentation manifest ${documentationId} could not be read`,
                { documentationId },
                error,
            );
        }
    }
}

function summaryFrom(manifest: DocumentationManifest, baseDirectory: string): DocumentationSummary {
    const indexedRevision = manifest.activeBuild?.configurationRevision;
    return {
        documentationId: manifest.documentationId,
        name: manifest.name,
        ...(manifest.description === undefined
            ? {}
            : { description: manifest.description }),
        sourceDefinitionCount: manifest.sourceDefinitions.length,
        indexedSourceCount: manifest.activeBuild?.indexedSources.length ?? 0,
        configurationRevision: manifest.configurationRevision,
        ...(indexedRevision === undefined ? {} : { indexedConfigurationRevision: indexedRevision }),
        needsIndex: indexedRevision !== manifest.configurationRevision,
        databasePath: documentationDatabasePath(baseDirectory, manifest.documentationId),
        ...(manifest.activeBuild === undefined ? {} : { activeBuild: manifest.activeBuild }),
    };
}

function isManifest(value: DocumentationManifest): boolean {
    return value?.schemaVersion === DOCUMENTATION_MANIFEST_VERSION &&
        typeof value.documentationId === "string" &&
        typeof value.name === "string" &&
        (value.description === undefined || typeof value.description === "string") &&
        Number.isSafeInteger(value.configurationRevision) &&
        Array.isArray(value.sourceDefinitions) &&
        value.sourceDefinitions.every((source) =>
            source !== null &&
            (source.kind === "managed" || source.kind === "directory") &&
            typeof source.sourceId === "string"
        ) &&
        (value.activeBuild === undefined || Array.isArray(value.activeBuild.indexedSources));
}

function normalizeDocumentationName(name: string): string {
    const normalized = requiredText(name, "documentation name");
    if (normalized.length > 100) {
        throw new DocumentationError("invalid-documentation", "Documentation name is too long");
    }
    return normalized;
}

function normalizeDocumentationDescription(
    description: string | undefined,
): string | undefined {
    if (description === undefined) return undefined;
    const normalized = description.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0) return undefined;
    if (normalized.length > 1_000) {
        throw new DocumentationError(
            "invalid-documentation",
            "Documentation description is too long",
        );
    }
    return normalized;
}

function requiredText(value: string, field: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new DocumentationError("invalid-documentation", `${field} is required`);
    }
    return trimmed;
}

function normalizePatterns(patterns: readonly string[]): readonly string[] {
    return [...new Set(patterns.map((pattern) => requiredText(pattern, "pattern")))].sort();
}

function normalizeTags(tags: readonly string[]): readonly string[] {
    return [...new Set(tags.map((tag) => requiredText(tag, "tag")))].sort();
}

function mutateTags(
    current: readonly string[],
    mutation: SourceTagMutation,
    tags: readonly string[],
): readonly string[] {
    if (mutation === "set") return tags;
    if (mutation === "add") return normalizeTags([...current, ...tags]);
    if (mutation === "remove") {
        const removed = new Set(tags);
        return current.filter((tag) => !removed.has(tag));
    }
    return [];
}

function equalTags(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function normalizeAttributes(
    attributes: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
    const normalized: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(attributes).sort()) {
        const value = attributes[key];
        if (
            key.trim().length === 0 || value === undefined ||
            !["string", "number", "boolean"].includes(typeof value) ||
            (typeof value === "string" && value.trim().length === 0) ||
            (typeof value === "number" && !Number.isFinite(value))
        ) {
            throw new DocumentationError(
                "invalid-documentation",
                "Source attributes must have non-empty keys and scalar values",
                { key },
            );
        }
        normalized[key] = value;
    }
    return normalized;
}

function normalizeMaximumFileByteLength(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new DocumentationError(
            "invalid-documentation",
            "maximumFileByteLength must be a positive integer",
        );
    }
    return value;
}

function equalSourceDefinitions(
    left: DocumentationSourceDefinition,
    right: DocumentationSourceDefinition,
): boolean {
    const omitUpdatedAt = (source: DocumentationSourceDefinition) => {
        const { updatedAt: _updatedAt, ...comparable } = source;
        return comparable;
    };
    return JSON.stringify(omitUpdatedAt(left)) === JSON.stringify(omitUpdatedAt(right));
}

function sortSourceDefinitions(
    sources: readonly DocumentationSourceDefinition[],
): readonly DocumentationSourceDefinition[] {
    return [...sources].sort((left, right) => {
        const leftPath = left.kind === "directory" ? left.mountPath : left.logicalPath;
        const rightPath = right.kind === "directory" ? right.mountPath : right.logicalPath;
        return leftPath.localeCompare(rightPath);
    });
}

function safeFilename(title: string): string {
    const safe = title.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
    return safe.length === 0 ? "document.txt" : safe;
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
