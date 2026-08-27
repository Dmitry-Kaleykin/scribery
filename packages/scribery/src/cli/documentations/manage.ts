import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    DocumentationCatalog,
    DocumentationIndexer,
    type SourceTagMutation,
} from "scribery-documents";
import { OpenAiCompatibleEmbeddingProvider } from "scribery-core";
import {
    nonNegativeInteger,
    positiveInteger,
    required,
} from "../arguments/values.js";
import { runCliEmbeddingProviderDiagnostic } from "../diagnostics/embedding-provider.js";
import { createCliProgressReporter } from "../progress/indexing-progress.js";
import { mediaTypeFromPath } from "./media-types.js";

export async function runDocumentationCommand(args: readonly string[]): Promise<void> {
    const [operation, ...operationArguments] = args;
    const catalog = new DocumentationCatalog();

    if (operation === "create") {
        if (operationArguments.length !== 1) {
            throw new Error("documentation create requires exactly one name");
        }
        console.log(JSON.stringify(
            await catalog.create(required(operationArguments[0], "documentation name")),
            null,
            2,
        ));
        return;
    }

    if (operation === "list") {
        if (operationArguments.length !== 0) {
            throw new Error("documentation list does not accept arguments");
        }
        const documentations = await catalog.list();
        console.log(JSON.stringify({ count: documentations.length, documentations }, null, 2));
        return;
    }

    if (operation === "delete") {
        if (operationArguments.length !== 1) {
            throw new Error("documentation delete requires exactly one documentation");
        }
        console.log(JSON.stringify({
            deleted: true,
            ...await catalog.delete(required(operationArguments[0], "documentation")),
        }, null, 2));
        return;
    }

    if (operation === "build") {
        await runDocumentationBuild(operationArguments, catalog);
        return;
    }

    throw new Error("documentation requires create, list, build, or delete");
}

export async function runSourceCommand(args: readonly string[]): Promise<void> {
    const [operation, ...operationArguments] = args;
    const catalog = new DocumentationCatalog();

    if (operation === "list") {
        if (operationArguments.length !== 1) {
            throw new Error("source list requires exactly one documentation");
        }
        const manifest = await catalog.resolve(required(
            operationArguments[0],
            "documentation",
        ));
        console.log(JSON.stringify({
            documentationId: manifest.documentationId,
            count: manifest.sources.length,
            sources: manifest.sources,
            needsBuild: manifest.builtSourcesRevision !== manifest.sourcesRevision,
        }, null, 2));
        return;
    }

    if (operation === "add") {
        await addSources(operationArguments, catalog);
        return;
    }

    if (operation === "remove") {
        if (operationArguments.length < 2) {
            throw new Error("source remove requires a documentation and source identifiers");
        }
        const manifest = await catalog.removeSources(
            required(operationArguments[0], "documentation"),
            operationArguments.slice(1),
        );
        printSourceMutation(manifest);
        return;
    }

    if (operation === "tags") {
        await updateSourceTags(operationArguments, catalog);
        return;
    }

    throw new Error("source requires add, list, remove, or tags");
}

async function runDocumentationBuild(
    args: readonly string[],
    catalog: DocumentationCatalog,
): Promise<void> {
    const parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
            model: { type: "string" },
            dimensions: { type: "string" },
            "base-url": { type: "string" },
            "embedding-suffix": { type: "string" },
            "embedding-batch-size": { type: "string" },
            "chunk-size": { type: "string" },
            overlap: { type: "string" },
            "windows-1251": { type: "boolean" },
        },
    });
    const reference = required(parsed.positionals[0], "documentation");
    if (parsed.positionals.length !== 1) {
        throw new Error("documentation build requires exactly one documentation");
    }
    const provider = new OpenAiCompatibleEmbeddingProvider({
        model: required(parsed.values.model, "--model"),
        dimensions: positiveInteger(parsed.values.dimensions, "--dimensions"),
        ...(parsed.values["base-url"] === undefined
            ? {}
            : { baseUrl: parsed.values["base-url"] }),
        ...(parsed.values["embedding-suffix"] === undefined
            ? {}
            : { embeddingSuffix: parsed.values["embedding-suffix"] }),
        ...(parsed.values["embedding-batch-size"] === undefined
            ? {}
            : {
                maximumInputs: positiveInteger(
                    parsed.values["embedding-batch-size"],
                    "--embedding-batch-size",
                ),
            }),
        ...((process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) === undefined
            ? {}
            : { apiKey: (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) }),
    });
    await runCliEmbeddingProviderDiagnostic(provider);
    const reportProgress = createCliProgressReporter();
    const result = await new DocumentationIndexer(catalog, provider).build(reference, {
        ...(parsed.values["chunk-size"] === undefined
            ? {}
            : {
                maximumChunkSize: positiveInteger(
                    parsed.values["chunk-size"],
                    "--chunk-size",
                ),
            }),
        ...(parsed.values.overlap === undefined
            ? {}
            : {
                slidingWindowOverlap: nonNegativeInteger(
                    parsed.values.overlap,
                    "--overlap",
                ),
            }),
        ...(parsed.values["embedding-batch-size"] === undefined
            ? {}
            : {
                maximumEmbeddingInputsPerBatch: positiveInteger(
                    parsed.values["embedding-batch-size"],
                    "--embedding-batch-size",
                ),
            }),
        ...(parsed.values["windows-1251"] === true
            ? { encodingFallback: "windows-1251" as const }
            : {}),
        onProgress: (progress) => reportProgress({
            phase: progress.phase,
            completed: progress.completed,
            total: progress.total,
            ...(progress.phase === "complete"
                ? { discoveredFiles: progress.total }
                : {}),
            ...(progress.currentSourceId === undefined
                ? {}
                : { currentPath: progress.currentSourceId }),
            ...(progress.reusedDocuments === undefined
                ? {}
                : { reusedDocuments: progress.reusedDocuments }),
            ...(progress.reusedChunks === undefined
                ? {}
                : { reusedChunks: progress.reusedChunks }),
            ...(progress.reusedEmbeddings === undefined
                ? {}
                : { reusedEmbeddings: progress.reusedEmbeddings }),
            ...(progress.generatedEmbeddings === undefined
                ? {}
                : { generatedEmbeddings: progress.generatedEmbeddings }),
        }),
    });
    console.log(JSON.stringify(result, null, 2));
}

async function addSources(
    args: readonly string[],
    catalog: DocumentationCatalog,
): Promise<void> {
    const parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
            tag: { type: "string", multiple: true },
            encoding: { type: "string" },
        },
    });
    const reference = required(parsed.positionals[0], "documentation");
    const filePaths = parsed.positionals.slice(1);
    if (filePaths.length === 0) throw new Error("source add requires at least one file");
    const encodingValue = parsed.values.encoding;
    if (
        encodingValue !== undefined &&
        encodingValue !== "utf-8" &&
        encodingValue !== "windows-1251"
    ) {
        throw new Error("--encoding must be utf-8 or windows-1251");
    }
    const encoding = encodingValue === "utf-8"
        ? "utf-8" as const
        : encodingValue === "windows-1251"
            ? "windows-1251" as const
            : undefined;
    const documents = await Promise.all(filePaths.map(async (filePath) => {
        const absolutePath = resolve(filePath);
        const title = basename(absolutePath);
        return {
            externalId: `file:${absolutePath}`,
            content: await readFile(absolutePath),
            title,
            mediaType: mediaTypeFromPath(absolutePath),
            originalLocation: absolutePath,
            ...(parsed.values.tag === undefined ? {} : { tags: parsed.values.tag }),
            ...(encoding === undefined ? {} : { encoding }),
        };
    }));
    const manifest = await catalog.upsertDocuments(reference, documents);
    printSourceMutation(manifest);
}

async function updateSourceTags(
    args: readonly string[],
    catalog: DocumentationCatalog,
): Promise<void> {
    const [mutationValue, ...mutationArguments] = args;
    if (!isSourceTagMutation(mutationValue)) {
        throw new Error("source tags requires set, add, remove, or clear");
    }

    const parsed = parseArgs({
        args: mutationArguments,
        allowPositionals: true,
        options: {
            tag: { type: "string", multiple: true },
        },
    });
    const reference = required(parsed.positionals[0], "documentation");
    const sourceIds = parsed.positionals.slice(1);
    if (sourceIds.length === 0) {
        throw new Error(`source tags ${mutationValue} requires source identifiers`);
    }

    const manifest = await catalog.updateSourceTags(
        reference,
        sourceIds,
        mutationValue,
        parsed.values.tag ?? [],
    );
    const selected = new Set(sourceIds);
    console.log(JSON.stringify({
        documentationId: manifest.documentationId,
        sourcesRevision: manifest.sourcesRevision,
        needsBuild: manifest.builtSourcesRevision !== manifest.sourcesRevision,
        sources: manifest.sources
            .filter(({ sourceId }) => selected.has(sourceId))
            .map(({ sourceId, tags }) => ({ sourceId, tags })),
    }, null, 2));
}

function isSourceTagMutation(value: string | undefined): value is SourceTagMutation {
    return value === "set" || value === "add" || value === "remove" || value === "clear";
}

function printSourceMutation(manifest: {
    documentationId: string;
    sources: readonly unknown[];
    sourcesRevision: number;
    builtSourcesRevision?: number;
}): void {
    console.log(JSON.stringify({
        documentationId: manifest.documentationId,
        sourceCount: manifest.sources.length,
        sourcesRevision: manifest.sourcesRevision,
        needsBuild: manifest.builtSourcesRevision !== manifest.sourcesRevision,
    }, null, 2));
}
