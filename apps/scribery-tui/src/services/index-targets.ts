import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
    hashText,
    inspectSourceState,
    LIVE_CURRENT_TARGET,
    normalizeRetrievalTargetName,
} from "scribery";

const run = promisify(execFile);
const gitOptions = { encoding: "utf8" as const, timeout: 5_000 };

export async function detectProjectRoot(cwd: string): Promise<string> {
    try {
        const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], {
            ...gitOptions, cwd,
        });
        return stdout.trim() ? resolve(stdout.trim()) : cwd;
    } catch {
        return cwd;
    }
}

export function normalizeManualIndexTarget(value: string): string {
    const target = normalizeRetrievalTargetName(value);
    if (target === LIVE_CURRENT_TARGET) {
        throw new Error(`${LIVE_CURRENT_TARGET} is reserved for live indexing`);
    }
    return target;
}

function branchTargetName(branch: string): string {
    try {
        return normalizeManualIndexTarget(branch);
    } catch {
        const slug = branch.normalize("NFKD")
            .replace(/[^A-Za-z0-9._/-]+/gu, "-")
            .replace(/\.{2,}/gu, ".")
            .replace(/\/{2,}/gu, "/")
            .replace(/^[/.-]+|[/.-]+$/gu, "")
            .slice(0, 96) || "branch";
        const hash = hashText(branch).replace(/^sha256:/u, "").slice(0, 10);
        return normalizeManualIndexTarget(`branch-${slug}-${hash}`);
    }
}

export async function currentGitIndexTarget(root: string): Promise<AutocompleteItem | undefined> {
    const source = await inspectSourceState(root, { timeoutMilliseconds: 5_000 });
    if (source.kind !== "git") return undefined;
    if (source.state.refName !== undefined) {
        const branch = source.state.refName;
        const target = branchTargetName(branch);
        return { value: target, label: target, description: `Current Git branch: ${branch}` };
    }
    if (source.state.detached && source.state.headCommit !== undefined) {
        const target = `detached-${source.state.headCommit.slice(0, 12)}`;
        return { value: target, label: target, description: "Current detached HEAD" };
    }
    return undefined;
}

export async function localBranchIndexTargets(root: string): Promise<AutocompleteItem[]> {
    try {
        const { stdout } = await run("git", [
            "for-each-ref", "--format=%(refname:strip=2)", "refs/heads/",
        ], { ...gitOptions, cwd: root });
        return stdout.split("\n").filter(Boolean).map((branch) => {
            const target = branchTargetName(branch);
            return { value: target, label: target, description: `Git branch: ${branch}` };
        });
    } catch {
        return [];
    }
}
