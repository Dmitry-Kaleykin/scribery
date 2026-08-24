import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    RETRIEVAL_TARGETS_FILENAME,
    RETRIEVAL_TARGETS_VERSION,
} from "scribery-core";
import type {
    ProjectRetrievalSelection,
    ProjectRetrievalTarget,
    ProjectRetrievalTargets,
} from "../contracts/retrieval-target.js";
import {
    managedIndexesDirectory,
    managedProjectDirectory,
    validateManagedProjectIdentifier,
} from "../managed/paths.js";
import { normalizeRetrievalTargetName } from "../validation/retrieval-target.js";

export { normalizeRetrievalTargetName } from "../validation/retrieval-target.js";

export class ProjectRetrievalTargetCatalog {
    readonly #indexesDirectory: string;

    constructor(indexesDirectory = managedIndexesDirectory()) {
        this.#indexesDirectory = indexesDirectory;
    }

    async read(projectIdentifier: string): Promise<ProjectRetrievalTargets> {
        validateManagedProjectIdentifier(projectIdentifier);
        const path = this.#path(projectIdentifier);

        try {
            const value = JSON.parse(await readFile(path, "utf8")) as unknown;
            return validateManifest(value, projectIdentifier);
        } catch (error: unknown) {
            if (isMissing(error)) return emptyManifest(projectIdentifier);
            throw error;
        }
    }

    async setTarget(
        projectIdentifier: string,
        name: string,
        indexBuildId: string,
        activate: boolean,
        keepReplacedBuilds?: number,
    ): Promise<ProjectRetrievalTargets> {
        const target = normalizeRetrievalTargetName(name);
        const build = requiredBuildId(indexBuildId);
        const manifest = await this.read(projectIdentifier);
        const previous = manifest.targets.find((entry) => entry.name === target);
        const now = new Date().toISOString();
        const retainedBuildIds = resolveRetainedBuildIds(
            previous,
            build,
            keepReplacedBuilds,
        );
        const entry: ProjectRetrievalTarget = {
            name: target,
            indexBuildId: build,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            ...(retainedBuildIds.length === 0 ? {} : { retainedBuildIds }),
        };
        const targets = manifest.targets
            .filter((candidate) => candidate.name !== target)
            .concat(entry)
            .sort((left, right) => left.name.localeCompare(right.name));
        const updated: ProjectRetrievalTargets = {
            ...manifest,
            updatedAt: now,
            targets,
            ...(activate
                ? { active: { type: "target" as const, target } }
                : {}),
        };
        await this.#write(updated);
        return updated;
    }

    async setActive(
        projectIdentifier: string,
        selection: ProjectRetrievalSelection,
    ): Promise<ProjectRetrievalTargets> {
        const manifest = await this.read(projectIdentifier);
        const active = selection.type === "target"
            ? {
                type: "target" as const,
                target: normalizeRetrievalTargetName(selection.target),
            }
            : {
                type: "build" as const,
                indexBuildId: requiredBuildId(selection.indexBuildId),
            };

        if (
            active.type === "target" &&
            !manifest.targets.some(({ name }) => name === active.target)
        ) {
            throw new Error(`Retrieval target ${active.target} was not found`);
        }

        const updated = {
            ...manifest,
            active,
            updatedAt: new Date().toISOString(),
        };
        await this.#write(updated);
        return updated;
    }

    async renameTarget(
        projectIdentifier: string,
        name: string,
        nextName: string,
    ): Promise<ProjectRetrievalTargets> {
        const target = normalizeRetrievalTargetName(name);
        const renamedTarget = normalizeRetrievalTargetName(nextName);
        const manifest = await this.read(projectIdentifier);
        const entry = manifest.targets.find(({ name }) => name === target);

        if (entry === undefined) {
            throw new Error(`Retrieval target ${target} was not found`);
        }
        if (target === renamedTarget) {
            return manifest;
        }
        if (manifest.targets.some(({ name }) => name === renamedTarget)) {
            throw new Error(`Retrieval target ${renamedTarget} already exists`);
        }

        const now = new Date().toISOString();
        const updated: ProjectRetrievalTargets = {
            ...manifest,
            updatedAt: now,
            targets: manifest.targets
                .map((candidate) => candidate.name === target
                    ? { ...candidate, name: renamedTarget, updatedAt: now }
                    : candidate)
                .sort((left, right) => left.name.localeCompare(right.name)),
            ...(manifest.active?.type === "target" &&
                    manifest.active.target === target
                ? {
                    active: {
                        type: "target" as const,
                        target: renamedTarget,
                    },
                }
                : {}),
        };
        await this.#write(updated);
        return updated;
    }

    async removeTarget(
        projectIdentifier: string,
        name: string,
    ): Promise<ProjectRetrievalTargets> {
        const target = normalizeRetrievalTargetName(name);
        const manifest = await this.read(projectIdentifier);

        if (!manifest.targets.some(({ name: candidate }) => candidate === target)) {
            throw new Error(`Retrieval target ${target} was not found`);
        }
        if (manifest.active?.type === "target" && manifest.active.target === target) {
            throw new Error(
                `Retrieval target ${target} is active and cannot be removed`,
            );
        }

        const updated = {
            ...manifest,
            updatedAt: new Date().toISOString(),
            targets: manifest.targets.filter(({ name: candidate }) => candidate !== target),
        };
        await this.#write(updated);
        return updated;
    }

    async #write(manifest: ProjectRetrievalTargets): Promise<void> {
        const path = this.#path(manifest.projectIdentifier);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
            temporaryPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryPath, path);
    }

    #path(projectIdentifier: string): string {
        return join(
            managedProjectDirectory(projectIdentifier, this.#indexesDirectory),
            RETRIEVAL_TARGETS_FILENAME,
        );
    }
}

function emptyManifest(projectIdentifier: string): ProjectRetrievalTargets {
    return {
        schemaVersion: RETRIEVAL_TARGETS_VERSION,
        projectIdentifier,
        updatedAt: new Date(0).toISOString(),
        targets: [],
    };
}

function validateManifest(
    value: unknown,
    projectIdentifier: string,
): ProjectRetrievalTargets {
    if (
        !isRecord(value) ||
        value.schemaVersion !== RETRIEVAL_TARGETS_VERSION ||
        value.projectIdentifier !== projectIdentifier ||
        typeof value.updatedAt !== "string" ||
        !Array.isArray(value.targets)
    ) {
        throw new Error("Project retrieval target catalog is invalid");
    }

    const targets = value.targets.map((entry): ProjectRetrievalTarget => {
        if (
            !isRecord(entry) ||
            typeof entry.name !== "string" ||
            typeof entry.indexBuildId !== "string" ||
            typeof entry.createdAt !== "string" ||
            typeof entry.updatedAt !== "string"
        ) {
            throw new Error("Project retrieval target catalog is invalid");
        }

        const currentBuildId = requiredBuildId(entry.indexBuildId);
        const retainedBuildIds = validateRetainedBuildIds(
            entry.retainedBuildIds,
            currentBuildId,
        );
        return {
            name: normalizeRetrievalTargetName(entry.name),
            indexBuildId: currentBuildId,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            ...(retainedBuildIds.length === 0 ? {} : { retainedBuildIds }),
        };
    });
    const names = new Set(targets.map(({ name }) => name));
    if (names.size !== targets.length) {
        throw new Error("Project retrieval target catalog contains duplicate targets");
    }

    const active = validateSelection(value.active, names);
    return {
        schemaVersion: RETRIEVAL_TARGETS_VERSION,
        projectIdentifier,
        updatedAt: value.updatedAt,
        targets: targets.sort((left, right) => left.name.localeCompare(right.name)),
        ...(active === undefined ? {} : { active }),
    };
}

function validateSelection(
    value: unknown,
    targets: ReadonlySet<string>,
): ProjectRetrievalSelection | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || typeof value.type !== "string") {
        throw new Error("Project retrieval selection is invalid");
    }
    if (value.type === "target" && typeof value.target === "string") {
        const target = normalizeRetrievalTargetName(value.target);
        if (!targets.has(target)) {
            throw new Error("Active project retrieval target was not found");
        }
        return { type: "target", target };
    }
    if (value.type === "build" && typeof value.indexBuildId === "string") {
        return { type: "build", indexBuildId: requiredBuildId(value.indexBuildId) };
    }

    throw new Error("Project retrieval selection is invalid");
}

function requiredBuildId(value: string): string {
    const build = value.trim();
    if (build.length === 0) throw new Error("Index build identifier must not be empty");
    return build;
}

function resolveRetainedBuildIds(
    previous: ProjectRetrievalTarget | undefined,
    nextBuildId: string,
    keepReplacedBuilds: number | undefined,
): readonly string[] {
    if (keepReplacedBuilds === undefined) {
        return (previous?.retainedBuildIds ?? []).filter(
            (indexBuildId) => indexBuildId !== nextBuildId,
        );
    }
    if (
        !Number.isSafeInteger(keepReplacedBuilds) ||
        keepReplacedBuilds < 0
    ) {
        throw new Error("Retained build count must be a non-negative integer");
    }

    const candidates = previous === undefined
        ? []
        : previous.indexBuildId === nextBuildId
            ? previous.retainedBuildIds ?? []
            : [previous.indexBuildId, ...(previous.retainedBuildIds ?? [])];
    return [...new Set(candidates)]
        .filter((indexBuildId) => indexBuildId !== nextBuildId)
        .slice(0, keepReplacedBuilds);
}

function validateRetainedBuildIds(
    value: unknown,
    currentBuildId: string,
): readonly string[] {
    if (value === undefined) return [];
    if (
        !Array.isArray(value) ||
        value.some((indexBuildId) => typeof indexBuildId !== "string")
    ) {
        throw new Error("Project retrieval target catalog is invalid");
    }

    const retainedBuildIds = value.map((indexBuildId) =>
        requiredBuildId(indexBuildId as string)
    );
    if (
        new Set(retainedBuildIds).size !== retainedBuildIds.length ||
        retainedBuildIds.includes(currentBuildId)
    ) {
        throw new Error("Project retrieval target catalog is invalid");
    }
    return retainedBuildIds;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
