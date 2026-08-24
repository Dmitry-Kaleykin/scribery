import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
    ProjectPreference,
    ProjectPreferenceInput,
    ProjectPreferencesFile,
} from "../domain/project-preferences.js";

export function defaultPreferencePath(): string {
    const home = process.env.SCRIBERY_TUI_HOME?.trim();
    return home
        ? join(resolve(home), "project-preferences.json")
        : join(homedir(), ".scribery", "tui", "project-preferences.json");
}

export class ProjectPreferenceStore {
    readonly #path: string;

    constructor(path = defaultPreferencePath()) {
        this.#path = path;
    }

    async list(): Promise<readonly ProjectPreference[]> {
        return (await this.#read()).projects;
    }

    async get(projectIdentifier: string): Promise<ProjectPreference | undefined> {
        return (await this.#read()).projects.find(
            (project) => project.projectIdentifier === projectIdentifier,
        );
    }

    async getByRoot(root: string): Promise<ProjectPreference | undefined> {
        const resolvedRoot = resolve(root);
        return (await this.#read()).projects.find(
            (project) => resolve(project.root) === resolvedRoot,
        );
    }

    async set(input: ProjectPreferenceInput): Promise<ProjectPreference> {
        const file = await this.#read();
        const preference: ProjectPreference = {
            projectIdentifier: input.projectIdentifier,
            root: resolve(input.root),
            profile: required(input.profile, "profile"),
            preset: required(input.preset, "preset"),
            target: input.target?.trim() || "main",
            keepReplacedBuilds: input.keepReplacedBuilds ?? 1,
            allowDirty: input.allowDirty ?? false,
            updatedAt: new Date().toISOString(),
        };
        if (!Number.isSafeInteger(preference.keepReplacedBuilds) || preference.keepReplacedBuilds < 0) {
            throw new Error("Replaced build retention must be a non-negative integer");
        }
        const projects = file.projects.filter(
            (project) => project.projectIdentifier !== preference.projectIdentifier,
        );
        await this.#write({ schemaVersion: 1, projects: [...projects, preference] });
        return preference;
    }

    async remove(projectIdentifier: string): Promise<void> {
        const file = await this.#read();
        await this.#write({
            schemaVersion: 1,
            projects: file.projects.filter(
                (project) => project.projectIdentifier !== projectIdentifier,
            ),
        });
    }

    async replaceProfileReferences(
        currentName: string,
        nextName: string,
    ): Promise<number> {
        const current = required(currentName, "current profile");
        const next = required(nextName, "new profile");
        if (current === next) return 0;
        const file = await this.#read();
        const count = file.projects.filter(({ profile }) => profile === current).length;
        if (count === 0) return 0;
        const now = new Date().toISOString();
        await this.#write({
            schemaVersion: 1,
            projects: file.projects.map((project) =>
                project.profile === current
                    ? { ...project, profile: next, updatedAt: now }
                    : project
            ),
        });
        return count;
    }

    async replacePresetReferences(
        currentName: string,
        nextName: string,
    ): Promise<number> {
        const current = required(currentName, "current preset");
        const next = required(nextName, "new preset");
        if (current === next) return 0;
        const file = await this.#read();
        const count = file.projects.filter(({ preset }) => preset === current).length;
        if (count === 0) return 0;
        const now = new Date().toISOString();
        await this.#write({
            schemaVersion: 1,
            projects: file.projects.map((project) =>
                project.preset === current
                    ? { ...project, preset: next, updatedAt: now }
                    : project
            ),
        });
        return count;
    }

    async #read(): Promise<ProjectPreferencesFile> {
        try {
            const value = JSON.parse(await readFile(this.#path, "utf8")) as unknown;
            return validate(value);
        } catch (error: unknown) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return { schemaVersion: 1, projects: [] };
            }
            throw error;
        }
    }

    async #write(file: ProjectPreferencesFile): Promise<void> {
        const temporary = `${this.#path}.${randomUUID()}.tmp`;
        await mkdir(dirname(this.#path), { recursive: true });
        await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await rename(temporary, this.#path);
    }
}

function validate(value: unknown): ProjectPreferencesFile {
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.projects)) {
        throw new Error("Scribery TUI project preferences are invalid");
    }
    return {
        schemaVersion: 1,
        projects: value.projects.map((project) => validateProject(project)),
    };
}

function validateProject(value: unknown): ProjectPreference {
    if (
        !isRecord(value) ||
        typeof value.projectIdentifier !== "string" ||
        typeof value.root !== "string" ||
        typeof value.profile !== "string" ||
        typeof value.preset !== "string" ||
        typeof value.target !== "string" ||
        !Number.isSafeInteger(value.keepReplacedBuilds) ||
        (value.keepReplacedBuilds as number) < 0 ||
        typeof value.allowDirty !== "boolean" ||
        typeof value.updatedAt !== "string"
    ) {
        throw new Error("Scribery TUI project preference is invalid");
    }
    return value as unknown as ProjectPreference;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(value: string, name: string): string {
    const result = value.trim();
    if (!result) throw new Error(`${name} is required`);
    return result;
}
