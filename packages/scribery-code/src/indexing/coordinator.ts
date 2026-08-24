import {
    DEFAULT_MAXIMUM_CHUNK_SIZE,
    IndexBuildEngine,
    IndexingError,
    hashText,
    type DiscoveryOptions,
    type EmbeddingProvider,
    type FileTrait,
    type IndexingConfiguration,
    type IndexingCoordinatorOptions,
    type IndexingProgress,
    type IndexingResult,
    type StorageProvider,
} from "scribery-core";
import { ProjectSourceProvider } from "../sources/index.js";
import { CodeOnlyIndexingPolicy } from "./policies/code-only.js";

export class IndexingCoordinator {
    readonly #storage: StorageProvider;
    readonly #embeddingProvider: EmbeddingProvider;
    readonly #options: IndexingCoordinatorOptions;
    readonly #sources: ProjectSourceProvider;

    constructor(
        storage: StorageProvider,
        embeddingProvider: EmbeddingProvider,
        options: IndexingCoordinatorOptions = {},
        sources = new ProjectSourceProvider(),
    ) {
        this.#storage = storage;
        this.#embeddingProvider = embeddingProvider;
        this.#options = options;
        this.#sources = sources;
    }

    async index(configuration: IndexingConfiguration): Promise<IndexingResult> {
        validateConfiguration(configuration);
        emitProgress(configuration, { phase: "source-inspection" });
        const source = await this.#sources.prepare({
            root: configuration.root,
            ...(configuration.repositoryIdentity === undefined
                ? {}
                : { repositoryIdentity: configuration.repositoryIdentity }),
            ...(configuration.allowDirty === undefined
                ? {}
                : { allowDirty: configuration.allowDirty }),
            discoveryOptions: resolveDiscoveryOptions(
                configuration,
                this.#options,
            ),
            ...(configuration.signal === undefined
                ? {}
                : { signal: configuration.signal }),
            onDiscovery: () => emitProgress(configuration, {
                phase: "discovery",
                completed: 0,
                discoveredFiles: 0,
                discoveredBytes: 0,
            }),
            onProgress: (progress) => emitProgress(configuration, {
                phase: "discovery",
                completed: progress.completed,
                discoveredFiles: progress.completed,
                discoveredBytes: progress.discoveredBytes,
                currentPath: progress.currentPath,
            }),
        });
        emitProgress(configuration, {
            phase: "discovery",
            completed: source.documents.length,
            total: source.documents.length,
            discoveredFiles: source.documents.length,
            discoveredBytes: source.documents.reduce(
                (total, document) => total + document.bytes.byteLength,
                0,
            ),
        });
        const policyOptions = {
            ...this.#options.policyOptions,
            ...(configuration.maximumFileByteLength === undefined
                ? {}
                : { maxByteLength: configuration.maximumFileByteLength }),
            ...(configuration.excludedTraits === undefined
                ? {}
                : { excludedTraits: configuration.excludedTraits }),
        };

        return new IndexBuildEngine(
            this.#storage,
            this.#embeddingProvider,
        ).build({
            source,
            plan: {
                policy: new CodeOnlyIndexingPolicy(policyOptions),
                policyIdentity: codeOnlyPolicyIdentity(policyOptions),
                strategies: ["cast"],
                maximumChunkSize: configuration.maximumChunkSize ??
                    DEFAULT_MAXIMUM_CHUNK_SIZE,
                ...(configuration.maximumEmbeddingInputsPerBatch === undefined
                    ? {}
                    : {
                        maximumEmbeddingInputsPerBatch:
                            configuration.maximumEmbeddingInputsPerBatch,
                    }),
                ...(configuration.encodingFallback === undefined
                    ? {}
                    : { encodingFallback: configuration.encodingFallback }),
                ...(configuration.encodingOverrides === undefined
                    ? {}
                    : { encodingOverrides: configuration.encodingOverrides }),
                ...(configuration.signal === undefined
                    ? {}
                    : { signal: configuration.signal }),
                ...(configuration.onProgress === undefined
                    ? {}
                    : { onProgress: configuration.onProgress }),
            },
        });
    }
}

function codeOnlyPolicyIdentity(
    options: {
        maxByteLength?: number;
        excludedTraits?: readonly FileTrait[];
        oversizedFileAction?: "skip" | "reject";
    },
): string {
    return `code-only:${hashText(JSON.stringify({
        maxByteLength: options.maxByteLength ?? null,
        excludedTraits: options.excludedTraits ?? null,
        oversizedFileAction: options.oversizedFileAction ?? null,
    }))}`;
}

function emitProgress(
    configuration: IndexingConfiguration,
    progress: IndexingProgress,
): void {
    configuration.onProgress?.(progress);
}

function resolveDiscoveryOptions(
    configuration: IndexingConfiguration,
    coordinatorOptions: IndexingCoordinatorOptions,
): Omit<DiscoveryOptions, "signal"> {
    return {
        ...coordinatorOptions.discoveryOptions,
        ...(configuration.include === undefined
            ? {}
            : { include: configuration.include }),
        ...(configuration.exclude === undefined
            ? {}
            : { exclude: configuration.exclude }),
        ...(configuration.includeHidden === undefined
            ? {}
            : { includeHidden: configuration.includeHidden }),
        ...(configuration.maximumFileByteLength === undefined
            ? {}
            : { maxFileSize: configuration.maximumFileByteLength }),
    };
}

function validateConfiguration(configuration: IndexingConfiguration): void {
    if (configuration.root.trim().length === 0) {
        throw new IndexingError(
            "invalid-configuration",
            "Indexing root is required",
        );
    }
    if (
        configuration.maximumChunkSize !== undefined &&
        (
            !Number.isSafeInteger(configuration.maximumChunkSize) ||
            configuration.maximumChunkSize < 1
        )
    ) {
        throw new IndexingError(
            "invalid-configuration",
            "Maximum chunk size must be a positive safe integer",
        );
    }
    if (
        configuration.maximumEmbeddingInputsPerBatch !== undefined &&
        (
            !Number.isSafeInteger(
                configuration.maximumEmbeddingInputsPerBatch,
            ) ||
            configuration.maximumEmbeddingInputsPerBatch < 1
        )
    ) {
        throw new IndexingError(
            "invalid-configuration",
            "Maximum embedding batch size must be a positive safe integer",
        );
    }
}
