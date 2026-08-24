import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

export interface TerminalEditorCommand {
    command: string;
    arguments: readonly string[];
}

interface EditorProcessResult {
    status: number | null;
    error?: Error;
}

export interface JsonConfigEditorOptions {
    env?: NodeJS.ProcessEnv;
    temporaryRoot?: string;
    isExecutable?: (command: string) => boolean | Promise<boolean>;
    spawn?: (
        command: string,
        arguments_: readonly string[],
    ) => EditorProcessResult;
    beforeSpawn?: () => void;
    afterSpawn?: () => void;
}

export async function editJsonConfiguration<T>(
    value: T,
    label: string,
    options: JsonConfigEditorOptions = {},
): Promise<T | undefined> {
    const editor = await resolveTerminalEditor(options);
    const directory = await mkdtemp(join(
        options.temporaryRoot ?? tmpdir(),
        "scribery-config-",
    ));
    const path = join(directory, `${safeFileName(label)}.json`);
    const original = JSON.stringify(value, null, 2);

    try {
        await writeFile(path, `${original}\n`, { encoding: "utf8", mode: 0o600 });
        let processResult: EditorProcessResult;
        options.beforeSpawn?.();
        try {
            processResult = (options.spawn ?? runEditor)(
                editor.command,
                [...editor.arguments, path],
            );
        } finally {
            options.afterSpawn?.();
        }
        if (processResult.error !== undefined) throw processResult.error;
        if (processResult.status !== 0) {
            throw new Error(
                `${editor.command} exited with status ${processResult.status ?? "unknown"}`,
            );
        }

        const editedText = await readFile(path, "utf8");
        let edited: unknown;
        try {
            edited = JSON.parse(editedText) as unknown;
        } catch (error: unknown) {
            throw new Error("Edited configuration is not valid JSON", {
                cause: error,
            });
        }
        return JSON.stringify(edited) === JSON.stringify(value)
            ? undefined
            : edited as T;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function resolveTerminalEditor(
    options: Pick<JsonConfigEditorOptions, "env" | "isExecutable"> = {},
): Promise<TerminalEditorCommand> {
    const env = options.env ?? process.env;
    const isExecutable = options.isExecutable ?? ((command: string) =>
        executableExists(command, env));
    const candidates = [
        env.VISUAL,
        env.EDITOR,
        "micro",
        "nano",
    ];

    for (const candidate of candidates) {
        if (candidate === undefined || candidate.trim().length === 0) continue;
        const parsed = parseEditorCommand(candidate);
        if (await isExecutable(parsed.command)) return parsed;
    }

    throw new Error(
        "No terminal editor was found; set VISUAL or EDITOR, or install micro or nano",
    );
}

export function parseEditorCommand(value: string): TerminalEditorCommand {
    const parts: string[] = [];
    let current = "";
    let quote: "'" | "\"" | undefined;
    let escaped = false;
    let started = false;

    for (const character of value.trim()) {
        if (escaped) {
            current += character;
            escaped = false;
            started = true;
            continue;
        }
        if (character === "\\" && quote !== "'") {
            escaped = true;
            started = true;
            continue;
        }
        if (quote !== undefined) {
            if (character === quote) quote = undefined;
            else current += character;
            started = true;
            continue;
        }
        if (character === "'" || character === "\"") {
            quote = character;
            started = true;
            continue;
        }
        if (/\s/u.test(character)) {
            if (started) {
                parts.push(current);
                current = "";
                started = false;
            }
            continue;
        }
        current += character;
        started = true;
    }

    if (escaped || quote !== undefined) {
        throw new Error("VISUAL or EDITOR contains an incomplete quoted command");
    }
    if (started) parts.push(current);
    const [command, ...arguments_] = parts;
    if (command === undefined || command.length === 0) {
        throw new Error("VISUAL or EDITOR must name an executable");
    }
    return { command, arguments: arguments_ };
}

async function executableExists(
    command: string,
    env: NodeJS.ProcessEnv,
): Promise<boolean> {
    const candidates = isAbsolute(command) || command.includes("/") ||
            command.includes("\\")
        ? [command]
        : (env.PATH ?? "").split(delimiter).flatMap((directory) =>
            executableNames(command, env).map((name) => join(directory, name))
        );
    for (const candidate of candidates) {
        try {
            await access(candidate, constants.X_OK);
            return true;
        } catch {
            // Try the next PATH entry.
        }
    }
    return false;
}

function executableNames(command: string, env: NodeJS.ProcessEnv): readonly string[] {
    if (process.platform !== "win32") return [command];
    const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean);
    return extensions.some((extension) =>
            command.toLowerCase().endsWith(extension.toLowerCase())
        )
        ? [command]
        : extensions.map((extension) => `${command}${extension}`);
}

function runEditor(
    command: string,
    arguments_: readonly string[],
): EditorProcessResult {
    const result = spawnSync(command, arguments_, {
        stdio: "inherit",
        env: process.env,
    });
    return {
        status: result.status,
        ...(result.error === undefined ? {} : { error: result.error }),
    };
}

function safeFileName(value: string): string {
    const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    return normalized.length === 0 ? "configuration" : normalized;
}
