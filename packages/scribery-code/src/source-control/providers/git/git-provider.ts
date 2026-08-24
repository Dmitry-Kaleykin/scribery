import { realpath } from "node:fs/promises";
import { relative } from "node:path";

import { createRepositoryId, normalizeRelativePath } from "scribery-core";
import type {
    ResolvedRef,
    SourceControlContext,
    SourceControlOptions,
    SourceControlProvider,
    WorkingTreeChange,
    WorkingTreeChangeKind,
    WorkingTreeState,
} from "../../contracts/source-control.js";
import { SourceControlError } from "../../errors/source-control-error.js";
import { runGit } from "./run-git.js";

export class GitSourceControlProvider implements SourceControlProvider {
    async detect(
        root: string,
        options: SourceControlOptions = {},
    ): Promise<SourceControlContext | null> {
        let indexingRoot: string;

        try {
            indexingRoot = await realpath(root);
        } catch (error: unknown) {
            throw new SourceControlError(
                "invalid-root",
                `Indexing root does not exist: ${root}`,
                { path: root },
                error,
            );
        }

        let repositoryRoot: string;

        try {
            repositoryRoot = (await runGit(
                indexingRoot,
                ["rev-parse", "--show-toplevel"],
                options,
            )).stdout.trim();
        } catch (error: unknown) {
            if (isOrdinaryNotRepositoryError(error)) {
                return null;
            }

            throw error;
        }

        const relativeRoot = relative(repositoryRoot, indexingRoot)
            .replaceAll("\\", "/");
        const indexingRootRelativePath = relativeRoot.length === 0
            ? "."
            : normalizeRelativePath(relativeRoot);

        return {
            provider: "git",
            repositoryId: createRepositoryId(
                options.repositoryIdentity ?? repositoryRoot,
            ),
            repositoryRoot,
            indexingRoot,
            indexingRootRelativePath,
            worktreeRoot: repositoryRoot,
        };
    }

    async resolveCurrentState(
        context: SourceControlContext,
        options: SourceControlOptions = {},
    ): Promise<WorkingTreeState> {
        const headCommit = await optionalGitOutput(
            context.repositoryRoot,
            ["rev-parse", "--verify", "HEAD"],
            options,
        );
        const refName = await optionalGitOutput(
            context.repositoryRoot,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            options,
        );
        const status = await runGit(
            context.repositoryRoot,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            options,
        );
        const changes = parsePorcelainStatus(status.stdout);

        return {
            repositoryId: context.repositoryId,
            ...(headCommit === undefined ? {} : { headCommit }),
            ...(refName === undefined ? {} : { refName }),
            detached: headCommit !== undefined && refName === undefined,
            unborn: headCommit === undefined,
            dirty: changes.length > 0,
            changes,
        };
    }

    async resolveRef(
        context: SourceControlContext,
        ref: string,
        options: SourceControlOptions = {},
    ): Promise<ResolvedRef> {
        try {
            const result = await runGit(
                context.repositoryRoot,
                ["rev-parse", "--verify", `${ref}^{commit}`],
                options,
            );
            return { ref, commit: result.stdout.trim() };
        } catch (error: unknown) {
            throw new SourceControlError(
                "ref-not-found",
                `Git ref ${ref} could not be resolved`,
                { ref },
                error,
            );
        }
    }
}

async function optionalGitOutput(
    root: string,
    args: readonly string[],
    options: SourceControlOptions,
): Promise<string | undefined> {
    try {
        const output = (await runGit(root, args, options)).stdout.trim();
        return output.length === 0 ? undefined : output;
    } catch (error: unknown) {
        if (isOrdinaryGitExit(error)) {
            return undefined;
        }

        throw error;
    }
}

function parsePorcelainStatus(output: string): readonly WorkingTreeChange[] {
    const entries = output.split("\0").filter((entry) => entry.length > 0);
    const changes: WorkingTreeChange[] = [];

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];

        if (entry === undefined || entry.length < 4) {
            continue;
        }

        const stagedCode = entry[0] ?? " ";
        const unstagedCode = entry[1] ?? " ";
        const path = entry.slice(3).replaceAll("\\", "/");
        const renamedOrCopied = stagedCode === "R" || stagedCode === "C";
        const previousPath = renamedOrCopied ? entries[index + 1] : undefined;

        if (renamedOrCopied) {
            index += 1;
        }

        changes.push({
            path,
            ...(previousPath === undefined
                ? {}
                : { previousPath: previousPath.replaceAll("\\", "/") }),
            kind: changeKind(stagedCode, unstagedCode),
            staged: stagedCode !== " " && stagedCode !== "?",
            unstaged: unstagedCode !== " " || stagedCode === "?",
        });
    }

    return changes.sort((left, right) => compareText(left.path, right.path));
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function changeKind(staged: string, unstaged: string): WorkingTreeChangeKind {
    const codes = `${staged}${unstaged}`;

    if (codes === "??") return "untracked";
    if (codes.includes("U") || ["AA", "DD"].includes(codes)) return "conflicted";
    if (codes.includes("R")) return "renamed";
    if (codes.includes("C")) return "copied";
    if (codes.includes("D")) return "deleted";
    if (codes.includes("A")) return "added";
    return "modified";
}

function isOrdinaryNotRepositoryError(error: unknown): boolean {
    return isOrdinaryGitExit(error) &&
        String((error as { stderr?: unknown }).stderr).includes("not a git repository");
}

function isOrdinaryGitExit(error: unknown): boolean {
    return error instanceof Error && "code" in error &&
        typeof (error as { code?: unknown }).code === "number";
}
