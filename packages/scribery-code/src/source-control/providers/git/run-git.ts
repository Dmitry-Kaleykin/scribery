import { execFile } from "node:child_process";

import { SourceControlError } from "../../errors/source-control-error.js";
import type { SourceControlOptions } from "../../contracts/source-control.js";

export interface GitResult {
    stdout: string;
    stderr: string;
}

export function runGit(
    cwd: string,
    args: readonly string[],
    options: SourceControlOptions = {},
): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            ["-C", cwd, ...args],
            {
                encoding: "utf8",
                maxBuffer: 16 * 1024 * 1024,
                timeout: options.timeoutMilliseconds ?? 10_000,
                ...(options.signal === undefined
                    ? {}
                    : { signal: options.signal }),
            },
            (error, stdout, stderr) => {
                if (error === null) {
                    resolve({ stdout, stderr });
                    return;
                }

                const processError = error as NodeJS.ErrnoException & {
                    killed?: boolean;
                    signal?: string;
                };

                if (options.signal?.aborted === true) {
                    reject(new SourceControlError(
                        "cancelled",
                        `Source-control operation was cancelled for ${cwd}`,
                        { path: cwd },
                        error,
                    ));
                } else if (processError.code === "ENOENT") {
                    reject(new SourceControlError(
                        "git-unavailable",
                        "Git executable is unavailable",
                        {},
                        error,
                    ));
                } else if (processError.killed || processError.signal === "SIGTERM") {
                    reject(new SourceControlError(
                        "timeout",
                        `Git command timed out for ${cwd}`,
                        { path: cwd },
                        error,
                    ));
                } else {
                    reject(Object.assign(error, { stdout, stderr }));
                }
            },
        );
    });
}
