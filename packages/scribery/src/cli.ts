#!/usr/bin/env node

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    nonNegativeInteger,
    positiveInteger,
    required,
} from "./cli/arguments/values.js";
import {
    formatDocumentChunks,
    serializeDocumentChunks,
} from "./cli/chunks/format-document-chunks.js";
import {
    runDocumentationCommand,
    runSourceCommand,
} from "./cli/documentations/manage.js";
import { runPresetCommand } from "./cli/configuration/presets.js";
import { runProfileCommand } from "./cli/configuration/profiles.js";
import { runDocumentationSearchIfRequested } from "./cli/documentations/search.js";
import { createProjectIndexingEventReporter } from "./cli/progress/project-indexing-events.js";
import { runRetrievalCommand } from "./cli/projects/retrieval.js";
import { normalizeRelativePath } from "scribery-core";
import {
    IndexingPresetService,
    ProviderProfileService,
} from "scribery-core";
import {
    deleteIndexedProject,
    listIndexedProjects,
    normalizeRetrievalTargetName,
    ProjectIndexingService,
    ProjectInspectionService,
    PROJECT_INDEXING_EVENT_VERSION,
    ProjectRetrievalTargetService,
    type ProjectIndexingOutcome,
    type ProjectIndexingProvider,
} from "scribery-code";
import {
    createOpenAiCompatibleRerankingProvider,
    openAiCompatibleEmbeddingProviderFromBuild,
    SemanticRetriever,
} from "scribery-core";
import { SqliteStorageProvider } from "scribery-core";
import { serializeError } from "scribery-core";

const [command, ...commandArguments] = process.argv.slice(2);
const jsonProgressRequested = (
    command === "index" || command === "reindex"
) && commandArguments.includes("--json-progress");
const packageMetadata = createRequire(import.meta.url)("../package.json") as {
    version: string;
};

try {
    if (command === undefined || command === "help" || command === "--help" ||
        command === "-h") {
        printUsage();
    } else if (command === "version" || command === "--version" || command === "-v") {
        console.log(packageMetadata.version);
    } else if (command === "index") {
        await runIndex(commandArguments);
    } else if (command === "reindex") {
        await runReindex(commandArguments);
    } else if (command === "recipe") {
        await runRecipe(commandArguments);
    } else if (command === "profile") {
        await runProfileCommand(commandArguments);
    } else if (command === "preset") {
        await runPresetCommand(commandArguments);
    } else if (command === "search") {
        await runSearch(commandArguments);
    } else if (command === "chunks") {
        await runChunks(commandArguments);
    } else if (command === "documentation") {
        await runDocumentationCommand(commandArguments);
    } else if (command === "source") {
        await runSourceCommand(commandArguments);
    } else if (command === "list") {
        await runList(commandArguments);
    } else if (command === "delete") {
        await runDelete(commandArguments);
    } else if (command === "retrieval") {
        await runRetrievalCommand(commandArguments);
    } else if (command === "mcp") {
        const { runScriberyMcpServer } = await import("./mcp/index.js");
        await runScriberyMcpServer(commandArguments, packageMetadata.version);
    } else {
        printUsage();
        process.exitCode = 1;
    }
} catch (error: unknown) {
    const failure = serializeError(error);
    const output = jsonProgressRequested
        ? {
            schemaVersion: PROJECT_INDEXING_EVENT_VERSION,
            type: "operation-failed",
            timestamp: new Date().toISOString(),
            error: failure,
        }
        : {
            error: failure.code ?? "failure",
            message: failure.message,
            ...(failure.details === undefined ? {} : { details: failure.details }),
            ...(failure.cause === undefined ? {} : { cause: failure.cause }),
        };
    console.error(JSON.stringify(output, null, jsonProgressRequested ? 0 : 2));
    process.exitCode = 1;
}

async function runChunks(args: readonly string[]): Promise<void> {
    const parsed = parseArgs({
        args,
        options: {
            db: { type: "string" },
            build: { type: "string" },
            project: { type: "string" },
            path: { type: "string" },
            json: { type: "boolean" },
        },
    });
    const path = normalizeRelativePath(required(parsed.values.path, "--path"));
    const hasDatabase = parsed.values.db !== undefined;
    const hasBuild = parsed.values.build !== undefined;
    if (hasDatabase !== hasBuild) {
        throw new Error("--db and --build must be provided together");
    }
    if (hasDatabase && parsed.values.project !== undefined) {
        throw new Error("--project cannot be combined with --db and --build");
    }
    if (!hasDatabase) {
        const result = await new ProjectInspectionService().chunks({
            path,
            ...(parsed.values.project === undefined
                ? {}
                : { projectReference: parsed.values.project }),
        });
        if (parsed.values.json === true) {
            console.log(JSON.stringify(
                serializeDocumentChunks(result.indexBuildId, result.chunks),
                null,
                2,
            ));
        } else {
            process.stdout.write(
                formatDocumentChunks(result.indexBuildId, result.chunks),
            );
        }
        return;
    }
    const databasePath = resolve(required(parsed.values.db, "--db"));
    const indexBuildId = required(parsed.values.build, "--build");
    const storage = new SqliteStorageProvider(databasePath, {
        readOnly: true,
        immutable: true,
    });

    try {
        const build = await storage.getBuild(indexBuildId);

        if (build === undefined) {
            throw new Error(`Index build ${indexBuildId} was not found`);
        }

        if (build.status !== "ready") {
            throw new Error(
                `Index build ${indexBuildId} is ${build.status}; only ready builds can be inspected`,
            );
        }

        const chunks = await storage.getDocumentChunks({ indexBuildId, path });

        if (chunks === undefined) {
            throw new Error(
                `Indexed file ${path} was not found in build ${indexBuildId}`,
            );
        }

        if (parsed.values.json === true) {
            console.log(JSON.stringify(
                serializeDocumentChunks(indexBuildId, chunks),
                null,
                2,
            ));
        } else {
            process.stdout.write(formatDocumentChunks(indexBuildId, chunks));
        }
    } finally {
        await storage.close();
    }
}

async function runIndex(args: readonly string[]): Promise<void> {
    const parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
            db: { type: "string" },
            preset: { type: "string" },
            profile: { type: "string" },
            model: { type: "string" },
            dimensions: { type: "string" },
            "base-url": { type: "string" },
            "embedding-suffix": { type: "string" },
            "embedding-batch-size": { type: "string" },
            "chunk-size": { type: "string" },
            "windows-1251": { type: "boolean" },
            "no-windows-1251": { type: "boolean" },
            "allow-dirty": { type: "boolean" },
            target: { type: "string" },
            activate: { type: "boolean" },
            "keep-replaced-builds": { type: "string" },
            "json-progress": { type: "boolean" },
            include: { type: "string", multiple: true },
            exclude: { type: "string", multiple: true },
        },
    });
    const root = resolve(parsed.positionals[0] ?? ".");
    const preset = parsed.values.preset === undefined
        ? undefined
        : await new IndexingPresetService().get(parsed.values.preset);
    const retrievalTarget = parsed.values.target === undefined
        ? undefined
        : normalizeRetrievalTargetName(parsed.values.target);

    if (parsed.values.activate === true && retrievalTarget === undefined) {
        throw new Error("--activate requires --target <name>");
    }
    if (
        parsed.values["keep-replaced-builds"] !== undefined &&
        retrievalTarget === undefined
    ) {
        throw new Error("--keep-replaced-builds requires --target <name>");
    }
    const keepReplacedBuilds = parsed.values["keep-replaced-builds"] === undefined
        ? 1
        : nonNegativeInteger(
            parsed.values["keep-replaced-builds"],
            "--keep-replaced-builds",
        );
    if (
        parsed.values["windows-1251"] === true &&
        parsed.values["no-windows-1251"] === true
    ) {
        throw new Error(
            "--windows-1251 cannot be combined with --no-windows-1251",
        );
    }
    const hasInlineProvider = parsed.values.model !== undefined ||
        parsed.values.dimensions !== undefined ||
        parsed.values["base-url"] !== undefined ||
        parsed.values["embedding-suffix"] !== undefined ||
        parsed.values["embedding-batch-size"] !== undefined;
    if (preset !== undefined && hasInlineProvider) {
        throw new Error(
            "--preset cannot be combined with inline embedding provider options; use --profile to override its provider",
        );
    }
    const profile = parsed.values.profile ??
        (hasInlineProvider ? undefined : preset?.providerProfile);
    if (
        profile !== undefined &&
        hasInlineProvider
    ) {
        throw new Error(
            "--profile cannot be combined with embedding provider options",
        );
    }
    const embeddingBatchSize = parsed.values["embedding-batch-size"] === undefined
        ? undefined
        : positiveInteger(
            parsed.values["embedding-batch-size"],
            "--embedding-batch-size",
        );
    const provider: ProjectIndexingProvider = profile === undefined
        ? {
            type: "inline",
            embedding: {
                provider: "openai-compatible",
                model: required(parsed.values.model, "--model"),
                dimensions: positiveInteger(
                    parsed.values.dimensions,
                    "--dimensions",
                ),
                ...(embeddingBatchSize === undefined
                    ? {}
                    : { maximumInputs: embeddingBatchSize }),
                ...(parsed.values["base-url"] === undefined
                    ? {}
                    : { baseUrl: parsed.values["base-url"] }),
                ...(parsed.values["embedding-suffix"] === undefined
                    ? {}
                    : {
                        embeddingSuffix: required(
                            parsed.values["embedding-suffix"],
                            "--embedding-suffix",
                        ),
                    }),
            },
        }
        : { type: "profile", profile };
    const service = createProjectIndexingService();
    const maximumChunkSize = parsed.values["chunk-size"] === undefined
        ? preset?.maximumChunkSize
        : positiveInteger(
            parsed.values["chunk-size"],
            "--chunk-size",
        );
    const windows1251 = parsed.values["windows-1251"] === true
        ? true
        : parsed.values["no-windows-1251"] === true
            ? false
            : preset?.windows1251;
    const include = parsed.values.include ?? preset?.include;
    const exclude = parsed.values.exclude ?? preset?.exclude;
    const outcome = await service.index({
        root,
        provider,
        ...(parsed.values.db === undefined
            ? {}
            : { databasePath: resolve(parsed.values.db) }),
        ...(retrievalTarget === undefined ? {} : { target: retrievalTarget }),
        keepReplacedBuilds,
        ...(parsed.values["allow-dirty"] === true ? { allowDirty: true } : {}),
        ...(maximumChunkSize === undefined
            ? {}
            : { maximumChunkSize }),
        ...(windows1251 === undefined ? {} : { windows1251 }),
        ...(include === undefined ? {} : { include }),
        ...(exclude === undefined ? {} : { exclude }),
        onEvent: createProjectIndexingEventReporter(
            parsed.values["json-progress"] === true ? "json" : "human",
        ),
    });
    printProjectIndexingOutcome(outcome);
}

async function runReindex(args: readonly string[]): Promise<void> {
    const parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
            project: { type: "string" },
            "json-progress": { type: "boolean" },
        },
    });
    if (
        parsed.positionals.length > 1 ||
        (parsed.positionals.length === 1 && parsed.values.project !== undefined)
    ) {
        throw new Error(
            "reindex accepts one project reference or --project, but not both",
        );
    }
    const reference = parsed.values.project ?? parsed.positionals[0];
    const outcome = await createProjectIndexingService().reindex(
        reference,
        process.cwd(),
        createProjectIndexingEventReporter(
            parsed.values["json-progress"] === true ? "json" : "human",
        ),
    );
    printProjectIndexingOutcome(outcome);
}

async function runRecipe(args: readonly string[]): Promise<void> {
    const parsed = parseArgs({
        args,
        options: { project: { type: "string" } },
    });
    const recipe = await createProjectIndexingService().recipe(
        parsed.values.project,
    );
    if (recipe === undefined) {
        throw new Error("The indexed project has no saved indexing recipe");
    }
    console.log(JSON.stringify(recipe, null, 2));
}

function createProjectIndexingService(): ProjectIndexingService {
    return new ProjectIndexingService({
        ...((process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) === undefined
            ? {}
            : { apiKey: (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) }),
    });
}

function printProjectIndexingOutcome(outcome: ProjectIndexingOutcome): void {
    console.log(JSON.stringify({
        databasePath: outcome.summary.databasePath,
        indexBuildId: outcome.summary.indexBuildId,
        ...(outcome.project === undefined
            ? {}
            : { projectIdentifier: outcome.project.projectIdentifier }),
        status: outcome.summary.status,
        logPath: outcome.summary.logPath,
        ...(outcome.retrieval === undefined
            ? {}
            : { retrieval: outcome.retrieval }),
        ...(outcome.recipe === undefined
            ? {}
            : { recipe: outcome.recipe }),
        summary: {
            files: outcome.summary.discoveredFiles,
            documents: outcome.summary.indexedDocuments,
            chunks: outcome.summary.indexedChunks,
            diagnostics: outcome.summary.diagnosticCount,
            reusedDocuments: outcome.summary.reusedDocuments,
            reusedChunks: outcome.summary.reusedChunks,
            reusedEmbeddings: outcome.summary.reusedEmbeddings,
            generatedEmbeddings: outcome.summary.generatedEmbeddings,
        },
    }, null, 2));
}

async function runList(args: readonly string[]): Promise<void> {
    if (args.length > 0) {
        throw new Error("list does not accept arguments");
    }

    const projects = await listIndexedProjects();
    console.log(JSON.stringify({ count: projects.length, projects }, null, 2));
}

async function runDelete(args: readonly string[]): Promise<void> {
    if (args.length !== 1) {
        throw new Error("delete requires exactly one project identifier");
    }

    const deleted = await deleteIndexedProject(required(
        args[0],
        "project identifier",
    ));
    console.log(JSON.stringify({ deleted: true, ...deleted }, null, 2));
}

async function runSearch(args: readonly string[]): Promise<void> {
    if (await runDocumentationSearchIfRequested(args)) return;

    const parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
            db: { type: "string" },
            build: { type: "string" },
            project: { type: "string" },
            profile: { type: "string" },
            "base-url": { type: "string" },
            limit: { type: "string" },
            language: { type: "string" },
            "context-before": { type: "string" },
            "context-after": { type: "string" },
            "context-characters": { type: "string" },
            "rerank-model": { type: "string" },
            "rerank-candidates": { type: "string" },
            "rerank-fallback": { type: "boolean" },
            "rerank-instruction": { type: "string" },
        },
    });
    const query = parsed.positionals.join(" ").trim();
    const profileName = parsed.values.profile;
    if (
        profileName !== undefined &&
        (
            parsed.values["base-url"] !== undefined ||
            parsed.values["rerank-model"] !== undefined ||
            parsed.values["rerank-instruction"] !== undefined
        )
    ) {
        throw new Error(
            "--profile cannot be combined with retrieval provider options",
        );
    }
    const profile = profileName === undefined
        ? undefined
        : await new ProviderProfileService().get(profileName);

    if (
        parsed.values["rerank-model"] === undefined &&
        profile?.reranking === undefined &&
        hasRerankingOptions(parsed.values)
    ) {
        throw new Error("--rerank-model is required for reranking options");
    }

    const hasDatabase = parsed.values.db !== undefined;
    const hasBuild = parsed.values.build !== undefined;
    if (hasDatabase !== hasBuild) {
        throw new Error("--db and --build must be provided together");
    }
    if (hasDatabase && parsed.values.project !== undefined) {
        throw new Error("--project cannot be combined with --db and --build");
    }
    const managed = hasDatabase
        ? undefined
        : await new ProjectRetrievalTargetService().resolveProject(
            parsed.values.project,
        );
    const selection = managed === undefined
        ? undefined
        : await new ProjectRetrievalTargetService().activeSelection(managed);
    if (managed !== undefined && selection === undefined) {
        throw new Error(
            `Indexed project ${managed.projectIdentifier} has no ready build`,
        );
    }
    const databasePath = managed?.databasePath ??
        resolve(required(parsed.values.db, "--db"));
    const indexBuildId = selection?.indexBuildId ??
        required(parsed.values.build, "--build");
    const baseUrl = profile?.embedding.baseUrl ?? parsed.values["base-url"];
    const reranking = profile?.reranking;

    const storage = new SqliteStorageProvider(databasePath);

    try {
        const build = await storage.getBuild(indexBuildId);

        if (build === undefined) {
            throw new Error(`Index build ${indexBuildId} was not found`);
        }

        const provider = openAiCompatibleEmbeddingProviderFromBuild(build, {
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...((process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) === undefined
                ? {}
                : { apiKey: (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) }),
        });
        const rerankingModel = reranking?.model ??
            parsed.values["rerank-model"];
        const rerankingProvider = rerankingModel === undefined
            ? undefined
            : createOpenAiCompatibleRerankingProvider({
                model: rerankingModel,
                ...(reranking?.provider === "openai-compatible-rerank"
                    ? { protocol: "rerank" as const }
                    : {}),
                ...(reranking?.baseUrl === undefined && baseUrl === undefined
                    ? {}
                    : { baseUrl: reranking?.baseUrl ?? baseUrl }),
                ...((process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) === undefined
                    ? {}
                    : { apiKey: (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) }),
                ...((reranking === undefined || !("instruction" in reranking) ||
                        reranking.instruction === undefined) &&
                        parsed.values["rerank-instruction"] === undefined
                    ? {}
                    : {
                        instruction: (reranking !== undefined && "instruction" in reranking
                            ? reranking.instruction
                            : undefined) ??
                            parsed.values["rerank-instruction"],
                    }),
            });
        const retriever = new SemanticRetriever(
            storage,
            provider,
            rerankingProvider,
        );
        const results = await retriever.retrieve({
            repositoryId: build.repositoryId,
            snapshotId: build.snapshotId,
            indexBuildId,
            query,
            ...(parsed.values.limit === undefined
                ? {}
                : { limit: positiveInteger(parsed.values.limit, "--limit") }),
            ...(parsed.values.language === undefined
                ? {}
                : {
                    filters: [{
                        field: "language",
                        operator: "equals" as const,
                        value: parsed.values.language,
                    }],
                }),
            ...(hasContextOptions(parsed.values)
                ? {
                    context: {
                        ...(parsed.values["context-before"] === undefined
                            ? {}
                            : {
                                beforeChunks: nonNegativeInteger(
                                    parsed.values["context-before"],
                                    "--context-before",
                                ),
                            }),
                        ...(parsed.values["context-after"] === undefined
                            ? {}
                            : {
                                afterChunks: nonNegativeInteger(
                                    parsed.values["context-after"],
                                    "--context-after",
                                ),
                            }),
                        ...(parsed.values["context-characters"] === undefined
                            ? {}
                            : {
                                maximumCharacters: positiveInteger(
                                    parsed.values["context-characters"],
                                    "--context-characters",
                                ),
                            }),
                    },
                }
                : {}),
            ...(rerankingProvider === undefined
                ? {}
                : {
                    rerank: {
                        ...(parsed.values["rerank-candidates"] === undefined
                            ? {}
                            : {
                                candidateLimit: positiveInteger(
                                    parsed.values["rerank-candidates"],
                                    "--rerank-candidates",
                                ),
                            }),
                        ...(parsed.values["rerank-fallback"] === true
                            ? { failureMode: "use-semantic-order" as const }
                            : {}),
                    },
                }),
        });
        console.log(JSON.stringify(results, null, 2));
    } finally {
        await storage.close();
    }
}

function hasContextOptions(values: {
    "context-before"?: string;
    "context-after"?: string;
    "context-characters"?: string;
}): boolean {
    return values["context-before"] !== undefined ||
        values["context-after"] !== undefined ||
        values["context-characters"] !== undefined;
}

function hasRerankingOptions(values: {
    "rerank-candidates"?: string;
    "rerank-fallback"?: boolean;
    "rerank-instruction"?: string;
}): boolean {
    return values["rerank-candidates"] !== undefined ||
        values["rerank-fallback"] === true ||
        values["rerank-instruction"] !== undefined;
}

function printUsage(): void {
    console.log(`Scribery

Index:
    scribery index <root>
        (--preset <name> | --profile <name> |
         --model <id> --dimensions <n>) [--db <file>]
        [--base-url http://127.0.0.1:1234/v1]
        [--embedding-suffix <text>] [--embedding-batch-size <n>]
        [--chunk-size <characters>]
        [--windows-1251 | --no-windows-1251]
        [--target <name>] [--keep-replaced-builds <n>] [--allow-dirty]
        [--json-progress]
    scribery reindex [project-or-root] [--project <identifier-or-root>]
        [--json-progress]
    scribery recipe [--project <identifier-or-root>]

Provider profiles:
    scribery profile list
    scribery profile models [--base-url http://127.0.0.1:1234/v1]
    scribery profile inspect <model> [--base-url <url>]
    scribery profile show <name>
    scribery profile set <name> --model <id>
        (--dimensions <n> | --detect-dimensions)
        [--base-url http://127.0.0.1:1234/v1]
        [--embedding-suffix <text>] [--embedding-batch-size <n>]
        [--rerank-model <id>] [--rerank-instruction <text>]
    scribery profile test <name>
    scribery profile rename <current-name> <new-name>
    scribery profile delete <name>

Indexing presets:
    scribery preset list
    scribery preset show <name>
    scribery preset set <name> --profile <provider-profile>
        [--chunk-size <characters>] [--windows-1251]
        [--include <glob>] [--exclude <glob>]
    scribery preset rename <current-name> <new-name>
    scribery preset delete <name>

Search:
    scribery search <query> --profile <name>
        [--project <identifier-or-root>] [--language <language>] [--limit <n>]
    scribery search <query> --db <file> --build <indexBuildId>
        [--profile <name>] [--language <language>] [--limit <n>]
        [--context-before <n>] [--context-after <n>]
        [--context-characters <n>]
        [--rerank-model <id>] [--rerank-candidates <n>]
        [--rerank-instruction <text>] [--rerank-fallback]

Chunks:
    scribery chunks --path <relativePath> [--project <identifier-or-root>]
        [--json]
    scribery chunks --db <file> --build <indexBuildId> --path <relativePath>
        [--json]

Documentation:
    scribery documentation create <name> [--description <text>]
    scribery documentation describe <documentation> <description>
    scribery documentation list
    scribery documentation delete <documentation>
    scribery source add <documentation> <file...> [--tag <tag>] [--encoding <encoding>]
    scribery source add-directory <documentation> <directory> [--mount <path>]
        [--include <glob>] [--exclude <glob>] [--include-hidden] [--no-gitignore]
        [--max-file-size <bytes>] [--tag <tag>]
    scribery source list <documentation>
    scribery source remove <documentation> <sourceId...>
    scribery source tags set <documentation> <sourceId...> --tag <tag>
    scribery source tags add <documentation> <sourceId...> --tag <tag>
    scribery source tags remove <documentation> <sourceId...> --tag <tag>
    scribery source tags clear <documentation> <sourceId...>
    scribery documentation index <documentation> --model <id> --dimensions <n>
        [--chunk-size <characters>] [--overlap <characters>] [--windows-1251]
    scribery search <query> --documentation <documentation>
        [--source <sourceId>] [--tag <tag>] [--limit <n>]

Projects:
    scribery list
    scribery delete <projectIdentifier>

Retrieval targets:
    scribery retrieval list [--project <identifier-or-root>]
    scribery retrieval status [--project <identifier-or-root>]
    scribery retrieval set <target> --build <indexBuildId> [--activate]
        [--project <identifier-or-root>]
    scribery retrieval switch <target> [--project <identifier-or-root>]
    scribery retrieval switch --build <indexBuildId> [--project <identifier-or-root>]
    scribery retrieval rename <current> <new> [--project <identifier-or-root>]
    scribery retrieval remove <target> [--project <identifier-or-root>]

MCP (read-only stdio):
    scribery mcp [--project <identifier-or-root>]
        [--profile <name>]
        [--base-url http://127.0.0.1:1234/v1] [--api-key <key>]
        [--rerank-model <id>]
        [--rerank-instruction <text>] [--tools <name[,name...]>]

Set OPENAI_COMPATIBLE_API_KEY only when authentication is enabled. The legacy
LM_STUDIO_API_KEY name remains supported as a fallback.`);
}
