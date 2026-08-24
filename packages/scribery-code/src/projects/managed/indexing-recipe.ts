import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    normalizeProviderProfileName,
} from "scribery-core";
import {
    INDEXING_RECIPE_FILENAME,
    INDEXING_RECIPE_VERSION,
} from "scribery-core";
import type {
    ProjectIndexingProvider,
    ProjectIndexingRecipe,
    ProjectIndexingSettings,
} from "../contracts/indexing-recipe.js";
import {
    managedIndexesDirectory,
    managedProjectDirectory,
    validateManagedProjectIdentifier,
} from "./paths.js";
import { normalizeRetrievalTargetName } from "../validation/retrieval-target.js";

export class ProjectIndexingRecipeCatalog {
    readonly #indexesDirectory: string;

    constructor(indexesDirectory = managedIndexesDirectory()) {
        this.#indexesDirectory = indexesDirectory;
    }

    async read(projectIdentifier: string): Promise<ProjectIndexingRecipe | undefined> {
        validateManagedProjectIdentifier(projectIdentifier);
        try {
            return validateRecipe(
                JSON.parse(
                    await readFile(this.#path(projectIdentifier), "utf8"),
                ) as unknown,
                projectIdentifier,
            );
        } catch (error: unknown) {
            if (isMissing(error)) return undefined;
            throw error;
        }
    }

    async write(
        projectIdentifier: string,
        settings: ProjectIndexingSettings,
    ): Promise<ProjectIndexingRecipe> {
        validateManagedProjectIdentifier(projectIdentifier);
        const previous = await this.read(projectIdentifier);
        const normalized = validateSettings(settings);
        const now = new Date().toISOString();
        const recipe: ProjectIndexingRecipe = {
            schemaVersion: INDEXING_RECIPE_VERSION,
            projectIdentifier,
            ...normalized,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        await this.#writeRecipe(recipe);
        return recipe;
    }

    async replaceProviderProfileReferences(
        currentName: string,
        nextName: string,
    ): Promise<number> {
        const current = normalizeProviderProfileName(currentName);
        const next = normalizeProviderProfileName(nextName);
        if (current === next) return 0;
        const recipes: ProjectIndexingRecipe[] = [];
        for (const entry of await this.#entries()) {
            if (!entry.isDirectory() || !isManagedProjectIdentifier(entry.name)) {
                continue;
            }
            const recipe = await this.read(entry.name);
            if (
                recipe?.provider.type === "profile" &&
                recipe.provider.profile === current
            ) {
                recipes.push(recipe);
            }
        }
        if (recipes.length === 0) return 0;
        const now = new Date().toISOString();
        const applied: ProjectIndexingRecipe[] = [];
        try {
            for (const recipe of recipes) {
                await this.#writeRecipe({
                    ...recipe,
                    provider: { type: "profile", profile: next },
                    updatedAt: now,
                });
                applied.push(recipe);
            }
        } catch (error: unknown) {
            const rollbacks = await Promise.allSettled(
                applied.map((recipe) => this.#writeRecipe(recipe)),
            );
            const rollbackErrors = rollbacks.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : []
            );
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    "Profile rename failed and one or more project recipes could not be restored",
                );
            }
            throw error;
        }
        return recipes.length;
    }

    async #entries() {
        try {
            return await readdir(this.#indexesDirectory, { withFileTypes: true });
        } catch (error: unknown) {
            if (isMissing(error)) return [];
            throw error;
        }
    }

    async #writeRecipe(recipe: ProjectIndexingRecipe): Promise<void> {
        const path = this.#path(recipe.projectIdentifier);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
            temporaryPath,
            `${JSON.stringify(recipe, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryPath, path);
    }

    #path(projectIdentifier: string): string {
        return join(
            managedProjectDirectory(projectIdentifier, this.#indexesDirectory),
            INDEXING_RECIPE_FILENAME,
        );
    }
}

function isManagedProjectIdentifier(value: string): boolean {
    try {
        validateManagedProjectIdentifier(value);
        return true;
    } catch {
        return false;
    }
}

function validateRecipe(
    value: unknown,
    projectIdentifier: string,
): ProjectIndexingRecipe {
    if (
        !isRecord(value) ||
        value.schemaVersion !== INDEXING_RECIPE_VERSION ||
        value.projectIdentifier !== projectIdentifier ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
    ) {
        throw new Error("Project indexing recipe is invalid");
    }
    return {
        schemaVersion: INDEXING_RECIPE_VERSION,
        projectIdentifier,
        ...validateSettings(value as unknown as ProjectIndexingSettings),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}

function validateSettings(
    value: ProjectIndexingSettings,
): ProjectIndexingSettings {
    if (
        !isRecord(value) ||
        !Number.isSafeInteger(value.keepReplacedBuilds) ||
        value.keepReplacedBuilds < 0 ||
        (value.allowDirty !== undefined && typeof value.allowDirty !== "boolean") ||
        (value.windows1251 !== undefined && typeof value.windows1251 !== "boolean") ||
        (value.maximumChunkSize !== undefined &&
            (!Number.isSafeInteger(value.maximumChunkSize) ||
                value.maximumChunkSize < 1))
    ) {
        throw new Error("Project indexing recipe is invalid");
    }
    const provider = validateProvider(value.provider);
    const target = value.target === undefined
        ? undefined
        : validateTarget(value.target);
    const include = validatePatterns(value.include);
    const exclude = validatePatterns(value.exclude);
    return {
        provider,
        ...(target === undefined ? {} : { target }),
        keepReplacedBuilds: value.keepReplacedBuilds,
        ...(value.allowDirty === undefined
            ? {}
            : { allowDirty: value.allowDirty }),
        ...(value.maximumChunkSize === undefined
            ? {}
            : { maximumChunkSize: value.maximumChunkSize }),
        ...(value.windows1251 === undefined
            ? {}
            : { windows1251: value.windows1251 }),
        ...(include === undefined ? {} : { include }),
        ...(exclude === undefined ? {} : { exclude }),
    };
}

function validateProvider(value: unknown): ProjectIndexingProvider {
    if (!isRecord(value) || typeof value.type !== "string") {
        throw new Error("Project indexing recipe provider is invalid");
    }
    if (value.type === "profile" && typeof value.profile === "string") {
        return {
            type: "profile",
            profile: normalizeProviderProfileName(value.profile),
        };
    }
    if (value.type === "inline" && isRecord(value.embedding)) {
        const embedding = value.embedding;
        if (
            (embedding.provider !== "openai-compatible" &&
                embedding.provider !== "lm-studio") ||
            typeof embedding.model !== "string" ||
            embedding.model.trim().length === 0 ||
            !Number.isSafeInteger(embedding.dimensions) ||
            (embedding.dimensions as number) < 1 ||
            (embedding.baseUrl !== undefined &&
                typeof embedding.baseUrl !== "string") ||
            (embedding.maximumInputs !== undefined &&
                (!Number.isSafeInteger(embedding.maximumInputs) ||
                    (embedding.maximumInputs as number) < 1)) ||
            (embedding.embeddingSuffix !== undefined &&
                typeof embedding.embeddingSuffix !== "string")
        ) {
            throw new Error("Project inline embedding provider is invalid");
        }
        return {
            type: "inline",
            embedding: {
                provider: "openai-compatible",
                model: embedding.model.trim(),
                dimensions: embedding.dimensions as number,
                ...(embedding.baseUrl === undefined
                    ? {}
                    : { baseUrl: embedding.baseUrl as string }),
                ...(embedding.maximumInputs === undefined
                    ? {}
                    : { maximumInputs: embedding.maximumInputs as number }),
                ...(embedding.embeddingSuffix === undefined
                    ? {}
                    : { embeddingSuffix: embedding.embeddingSuffix as string }),
            },
        };
    }
    throw new Error("Project indexing recipe provider is invalid");
}

function validateTarget(value: unknown): string {
    if (typeof value !== "string") {
        throw new Error("Project indexing recipe target is invalid");
    }
    return normalizeRetrievalTargetName(value);
}

function validatePatterns(value: unknown): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (
        !Array.isArray(value) ||
        value.some((pattern) =>
            typeof pattern !== "string" || pattern.trim().length === 0
        )
    ) {
        throw new Error("Project indexing recipe patterns are invalid");
    }
    return value.map((pattern) => (pattern as string).trim());
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
