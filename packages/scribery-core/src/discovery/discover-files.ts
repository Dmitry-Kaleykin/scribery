import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";

import type {
    DiscoveryEvent,
    DiscoveryOptions,
    FileDiscovery,
} from "./contracts/discovery.js";
import { DiscoveryError } from "./errors/discovery-error.js";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

export class DefaultFileDiscovery implements FileDiscovery {
    async *discover(
        root: string,
        options: DiscoveryOptions = {},
    ): AsyncIterable<DiscoveryEvent> {
        validateOptions(options);

        let absoluteRoot: string;

        try {
            absoluteRoot = await realpath(root);
        } catch (error: unknown) {
            throw new DiscoveryError(
                "invalid-root",
                `Discovery root does not exist: ${root}`,
                { path: root },
                error,
            );
        }

        const ignored = await createIgnoreMatcher(absoluteRoot, options);
        const includeMatchers = (options.include ?? []).map((pattern) =>
            picomatch(pattern, { dot: true })
        );
        const pendingDirectories = [""];

        while (pendingDirectories.length > 0) {
            throwIfAborted(options.signal, absoluteRoot);

            const relativeDirectory = pendingDirectories.pop();

            if (relativeDirectory === undefined) {
                break;
            }

            const absoluteDirectory = relativeDirectory.length === 0
                ? absoluteRoot
                : join(absoluteRoot, relativeDirectory);
            let entries;

            try {
                entries = await readdir(absoluteDirectory, {
                    withFileTypes: true,
                });
            } catch (error: unknown) {
                yield diagnostic(
                    relativeDirectory || ".",
                    "entry-unreadable",
                    "Directory could not be read",
                    "error",
                );
                continue;
            }

            entries.sort((left, right) => compareText(left.name, right.name));
            const childDirectories: string[] = [];

            for (const entry of entries) {
                throwIfAborted(options.signal, absoluteRoot);

                const relativePath = relativeDirectory.length === 0
                    ? entry.name
                    : `${relativeDirectory}/${entry.name}`;
                const directoryPath = `${relativePath}/`;

                if (relativePath === ".git" || relativePath.startsWith(".git/")) {
                    continue;
                }

                if (
                    options.includeHidden !== true &&
                    relativePath.split("/").some((segment) => segment.startsWith("."))
                ) {
                    continue;
                }

                if (ignored.ignores(entry.isDirectory() ? directoryPath : relativePath)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    childDirectories.push(relativePath);
                    continue;
                }

                if (entry.isSymbolicLink()) {
                    yield diagnostic(
                        relativePath,
                        "symbolic-link-skipped",
                        "Symbolic links are not followed",
                        "warning",
                    );
                    continue;
                }

                if (!entry.isFile()) {
                    yield diagnostic(
                        relativePath,
                        "unsupported-entry",
                        "Filesystem entry is not a regular file",
                        "warning",
                    );
                    continue;
                }

                if (
                    includeMatchers.length > 0 &&
                    !includeMatchers.some((matches) => matches(relativePath))
                ) {
                    continue;
                }

                const absolutePath = join(absoluteRoot, relativePath);

                try {
                    const stats = await lstat(absolutePath);
                    const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

                    if (stats.size > maxFileSize) {
                        yield diagnostic(
                            relativePath,
                            "file-too-large",
                            `File exceeds the configured ${maxFileSize}-byte limit`,
                            "warning",
                        );
                        continue;
                    }

                    yield {
                        type: "file",
                        file: {
                            absolutePath,
                            relativePath,
                            size: stats.size,
                            modifiedAt: stats.mtime,
                        },
                    };
                } catch (error: unknown) {
                    yield diagnostic(
                        relativePath,
                        "entry-unreadable",
                        "File metadata could not be read",
                        "error",
                    );
                }
            }

            for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
                const child = childDirectories[index];

                if (child !== undefined) {
                    pendingDirectories.push(child);
                }
            }
        }
    }
}

async function createIgnoreMatcher(
    root: string,
    options: DiscoveryOptions,
): Promise<Ignore> {
    const matcher = ignore().add(options.exclude ?? []);

    if (options.useGitignore !== false) {
        try {
            matcher.add(await readFile(join(root, ".gitignore"), "utf8"));
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code !== "ENOENT") {
                throw new DiscoveryError(
                    "invalid-root",
                    "Root .gitignore could not be read",
                    { path: root },
                    error,
                );
            }
        }
    }

    return matcher;
}

function validateOptions(options: DiscoveryOptions): void {
    if (
        options.maxFileSize !== undefined &&
        (!Number.isSafeInteger(options.maxFileSize) || options.maxFileSize < 0)
    ) {
        throw new DiscoveryError(
            "invalid-options",
            "Discovery maximum file size must be a non-negative safe integer",
        );
    }
}

function throwIfAborted(signal: AbortSignal | undefined, path: string): void {
    if (signal?.aborted === true) {
        throw new DiscoveryError(
            "cancelled",
            `File discovery was cancelled for ${path}`,
            { path },
            signal.reason,
        );
    }
}

function diagnostic(
    path: string,
    code: "entry-unreadable" | "file-too-large" | "symbolic-link-skipped" | "unsupported-entry",
    message: string,
    severity: "warning" | "error",
): DiscoveryEvent {
    return {
        type: "diagnostic",
        diagnostic: { path, code, message, severity },
    };
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
