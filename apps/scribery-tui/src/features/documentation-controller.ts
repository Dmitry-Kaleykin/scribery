import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import type { SelectItem } from "@earendil-works/pi-tui";
import {
    DocumentationService,
    type DocumentationService as DocumentationServiceType,
    type DocumentationSummary,
    type IndexingPreset,
    type ProviderProfileService,
    type RetrievalResult,
} from "scribery";

import type { ProjectPreference } from "../domain/project-preferences.js";
import type { ManualOperationManager } from "../operations/manual-operation-manager.js";
import type { ProviderAccess } from "../services/provider-access.js";
import type { TranscriptTone } from "./contracts.js";

export interface DocumentationUi {
    append(message: string, tone?: TranscriptTone): void;
    appendError(error: unknown): void;
    pick(title: string, items: readonly SelectItem[]): Promise<SelectItem | undefined>;
    input(title: string, label: string, initialValue?: string): Promise<string | undefined>;
    confirm(title: string, defaultYes?: boolean): Promise<boolean>;
    showSearchResults(query: string, results: readonly RetrievalResult[]): void;
    requestRender(): void;
}

export interface DocumentationControllerOptions {
    cwd: string;
    ui: DocumentationUi;
    operations: ManualOperationManager;
    providerAccess: ProviderAccess;
    profiles: ProviderProfileService;
    presets(): Promise<readonly IndexingPreset[]>;
    pickPreset(
        presets: readonly IndexingPreset[],
        title: string,
    ): Promise<string | undefined>;
    activePreference(): ProjectPreference | undefined;
    searchProfile(): Promise<string | undefined>;
    liveRunning(): boolean;
}

export class DocumentationController {
    readonly #cwd: string;
    readonly #ui: DocumentationUi;
    readonly #operations: ManualOperationManager;
    readonly #providerAccess: ProviderAccess;
    readonly #profiles: ProviderProfileService;
    readonly #presets: () => Promise<readonly IndexingPreset[]>;
    readonly #pickPreset: DocumentationControllerOptions["pickPreset"];
    readonly #activePreference: () => ProjectPreference | undefined;
    readonly #searchProfile: () => Promise<string | undefined>;
    readonly #liveRunning: () => boolean;

    constructor(options: DocumentationControllerOptions) {
        this.#cwd = options.cwd;
        this.#ui = options.ui;
        this.#operations = options.operations;
        this.#providerAccess = options.providerAccess;
        this.#profiles = options.profiles;
        this.#presets = options.presets;
        this.#pickPreset = options.pickPreset;
        this.#activePreference = options.activePreference;
        this.#searchProfile = options.searchProfile;
        this.#liveRunning = options.liveRunning;
    }

    async manage(): Promise<void> {
        const context = await this.#documentationService();
        if (!context) return;
        const { service, profileName } = context;
        const documentations = await service.listDocumentations();
        const selection = await this.#ui.pick("Documentation", [
            { value: "__create", label: "+ Create documentation", description: "Create managed reference documentation" },
            ...documentations.map((documentation) => ({
                value: documentation.documentationId,
                label: documentation.name,
                description: `${documentation.sourceCount} sources · ${documentation.needsBuild ? "build required" : "ready"}`,
            })),
        ]);
        if (!selection) return;
        if (selection.value === "__create") {
            const name = (await this.#ui.input("Create documentation", "Name"))?.trim();
            if (!name) return;
            const created = await service.createDocumentation(name);
            this.#ui.append(`Created documentation ${created.name}.`, "success");
            return;
        }
        const documentation = documentations.find(({ documentationId }) => documentationId === selection.value)!;
        const action = await this.#ui.pick(documentation.name, [
            { value: "search", label: "Search documentation" },
            { value: "index", label: "Index documentation", description: profileName },
            { value: "sources", label: "Browse sources", description: `${documentation.sourceCount} sources` },
            { value: "add", label: "Add local files" },
            { value: "delete", label: "Delete documentation" },
        ]);
        if (!action) return;
        if (action.value === "search") {
            await this.#searchDocumentation(service, documentation);
        } else if (action.value === "index") {
            await this.#configureIndex(service, documentation, profileName);
        } else if (action.value === "sources") {
            await this.#manageSources(service, documentation);
        } else if (action.value === "add") {
            await this.#addSources(service, documentation);
        } else if (action.value === "delete" && await this.#ui.confirm(`Delete documentation ${documentation.name}?`, false)) {
            await service.deleteDocumentation(documentation.documentationId);
            this.#ui.append(`Deleted documentation ${documentation.name}.`, "success");
        }
    }

    async #documentationService(): Promise<{
        service: DocumentationServiceType;
        profileName: string;
    } | undefined> {
        const profiles = await this.#profiles.list();
        const profileName = await this.#searchProfile() ?? profiles[0]?.name;
        if (!profileName) {
            this.#ui.append("Create a provider profile before using documentation.", "warning");
            return undefined;
        }
        const profileService = await this.#providerAccess.profileService(profileName);
        const profile = await profileService.get(profileName);
        const rerankingProvider = profileService.createRerankingProvider(profile);
        return {
            profileName,
            service: new DocumentationService({
                embeddingProvider: profileService.createEmbeddingProvider(profile),
                ...(rerankingProvider === undefined ? {} : { rerankingProvider }),
            }),
        };
    }

    async #searchDocumentation(
        service: DocumentationServiceType,
        documentation: DocumentationSummary,
    ): Promise<void> {
        const query = await this.#ui.input(`Search ${documentation.name}`, "Query");
        if (!query?.trim()) return;
        const normalized = query.trim();
        const results = await service.retrieve(documentation.documentationId, {
            query: normalized,
            limit: 10,
            context: { beforeChunks: 1, afterChunks: 1, maximumCharacters: 12_000 },
            rerank: { candidateLimit: 30, failureMode: "use-semantic-order" },
        });
        this.#ui.showSearchResults(normalized, results);
    }

    async #configureIndex(
        service: DocumentationServiceType,
        documentation: DocumentationSummary,
        profileName: string,
    ): Promise<void> {
        if (this.#liveRunning()) {
            this.#ui.append("Stop live indexing before starting another indexing operation.", "warning");
            return;
        }
        if (this.#operations.active) {
            this.#ui.append(`An index is already running for ${basename(this.#operations.active.root)}.`, "warning");
            return;
        }
        const presets = await this.#presets();
        if (presets.length === 0) {
            this.#ui.append("Create an indexing preset with /preset before indexing documentation.", "warning");
            return;
        }
        const preferredPreset = this.#activePreference()?.preset;
        const preset = presets.find(({ name }) => name === preferredPreset) ??
            await this.#selectPresetValue(presets, "Select documentation indexing preset");
        if (!preset) return;
        if (!await this.#ui.confirm(`Index ${documentation.name} with ${profileName} · ${preset.name}?`)) return;
        void this.#startIndex(service, documentation, preset);
    }

    async #selectPresetValue(
        presets: readonly IndexingPreset[],
        title: string,
    ): Promise<IndexingPreset | undefined> {
        const name = await this.#pickPreset(presets, title);
        return presets.find((preset) => preset.name === name);
    }

    async #startIndex(
        service: DocumentationServiceType,
        documentation: DocumentationSummary,
        preset: IndexingPreset,
    ): Promise<void> {
        const operation = this.#operations.begin(
            `documentation:${documentation.name}`,
            `Preparing ${documentation.name}`,
        );
        const { controller } = operation;
        try {
            const sources = await service.listSources(documentation.documentationId);
            const sourcePaths = new Map(sources.map((source) => [source.sourceId, source.logicalPath]));
            const result = await service.buildDocumentation(documentation.documentationId, {
                ...(preset.maximumChunkSize === undefined ? {} : { maximumChunkSize: preset.maximumChunkSize }),
                ...(preset.windows1251 === true ? { encodingFallback: "windows-1251" as const } : {}),
                signal: controller.signal,
                onProgress: (progress) => this.#operations.update({
                    phase: progress.phase,
                    completed: progress.completed,
                    total: progress.total,
                    ...(progress.currentSourceId === undefined
                        ? {}
                        : { currentPath: sourcePaths.get(progress.currentSourceId) ?? progress.currentSourceId }),
                    discoveredFiles: sources.length,
                    ...(progress.reusedDocuments === undefined ? {} : { reusedDocuments: progress.reusedDocuments }),
                    ...(progress.reusedChunks === undefined ? {} : { reusedChunks: progress.reusedChunks }),
                    ...(progress.reusedEmbeddings === undefined ? {} : { reusedEmbeddings: progress.reusedEmbeddings }),
                    ...(progress.generatedEmbeddings === undefined ? {} : { generatedEmbeddings: progress.generatedEmbeddings }),
                }),
            });
            this.#ui.append(
                `✓ Indexed documentation ${documentation.name} in ${formatDuration(Date.now() - operation.startedAt)}\n` +
                `  ${result.sourceCount} sources · ${result.indexedChunks} chunks · ` +
                `${result.reusedEmbeddings} embeddings reused · build ${result.indexBuildId.slice(0, 12)}…`,
                "success",
            );
        } catch (error: unknown) {
            if (controller.signal.aborted) {
                this.#ui.append(`Indexing documentation ${documentation.name} was cancelled.`, "warning");
            } else {
                this.#ui.appendError(error);
            }
        } finally {
            this.#operations.finish();
            this.#ui.requestRender();
        }
    }

    async #manageSources(
        service: DocumentationServiceType,
        documentation: DocumentationSummary,
    ): Promise<void> {
        const sources = await service.listSources(documentation.documentationId);
        if (sources.length === 0) {
            this.#ui.append(`Documentation ${documentation.name} has no sources.`, "muted");
            return;
        }
        const selected = await this.#ui.pick(`${documentation.name} sources`, sources.map((source) => ({
            value: source.sourceId,
            label: source.logicalPath,
            description: source.tags.length > 0 ? source.tags.join(", ") : `${source.byteLength} bytes`,
        })));
        if (!selected) return;
        const source = sources.find(({ sourceId }) => sourceId === selected.value)!;
        const action = await this.#ui.pick(source.logicalPath, [
            { value: "show", label: "Show source details" },
            { value: "tags", label: "Set tags" },
            { value: "remove", label: "Remove source" },
        ]);
        if (!action) return;
        if (action.value === "show") {
            this.#ui.append(JSON.stringify(source, null, 2));
        } else if (action.value === "tags") {
            const tags = await this.#ui.input("Set source tags", "Comma separated", source.tags.join(", "));
            if (tags === undefined) return;
            await service.setSourceTags(documentation.documentationId, [source.sourceId], splitPatterns(tags));
            this.#ui.append(`Updated tags for ${source.logicalPath}.`, "success");
        } else if (action.value === "remove" && await this.#ui.confirm(`Remove ${source.logicalPath}?`, false)) {
            await service.removeSources(documentation.documentationId, [source.sourceId]);
            this.#ui.append(`Removed ${source.logicalPath} from ${documentation.name}.`, "success");
        }
    }

    async #addSources(
        service: DocumentationServiceType,
        documentation: DocumentationSummary,
    ): Promise<void> {
        const pathsText = await this.#ui.input("Add local files", "Paths (comma separated)");
        if (!pathsText?.trim()) return;
        const paths = splitPatterns(pathsText).map((path) => resolve(this.#cwd, path));
        const tagsText = await this.#ui.input("Tags for added sources", "Comma separated", "");
        if (tagsText === undefined) return;
        const tags = splitPatterns(tagsText);
        const documents = await Promise.all(paths.map(async (path) => ({
            externalId: path,
            content: new Uint8Array(await readFile(path)),
            logicalPath: basename(path),
            title: basename(path),
            mediaType: mediaTypeFor(path),
            ...(tags.length === 0 ? {} : { tags }),
            originalLocation: path,
        })));
        const manifest = await service.upsertDocuments(documentation.documentationId, documents);
        this.#ui.append(`Added ${documents.length} source(s) to ${manifest.name}. Run /documentation and choose Index documentation.`, "success");
    }
}

function splitPatterns(value: string): readonly string[] {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function mediaTypeFor(path: string): string {
    const extension = extname(path).toLowerCase();
    return ({
        ".css": "text/css",
        ".csv": "text/csv",
        ".html": "text/html",
        ".htm": "text/html",
        ".json": "application/json",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".pdf": "application/pdf",
        ".tsv": "text/tab-separated-values",
        ".txt": "text/plain",
        ".xml": "application/xml",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
    } as Readonly<Record<string, string>>)[extension] ?? "application/octet-stream";
}
