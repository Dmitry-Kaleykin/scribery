export type WorkingTreeChangeKind =
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "untracked"
    | "conflicted";

export interface WorkingTreeChange {
    path: string;
    previousPath?: string;
    kind: WorkingTreeChangeKind;
    staged: boolean;
    unstaged: boolean;
}

export interface SourceControlContext {
    provider: "git";
    repositoryId: string;
    repositoryRoot: string;
    indexingRoot: string;
    indexingRootRelativePath: string;
    worktreeRoot: string;
}

export interface WorkingTreeState {
    repositoryId: string;
    headCommit?: string;
    refName?: string;
    detached: boolean;
    unborn: boolean;
    dirty: boolean;
    changes: readonly WorkingTreeChange[];
}

export interface ResolvedRef {
    ref: string;
    commit: string;
}

export interface SourceControlOptions {
    repositoryIdentity?: string;
    timeoutMilliseconds?: number;
    signal?: AbortSignal;
}

export interface SourceControlProvider {
    detect(
        root: string,
        options?: SourceControlOptions,
    ): Promise<SourceControlContext | null>;
    resolveCurrentState(
        context: SourceControlContext,
        options?: SourceControlOptions,
    ): Promise<WorkingTreeState>;
    resolveRef(
        context: SourceControlContext,
        ref: string,
        options?: SourceControlOptions,
    ): Promise<ResolvedRef>;
}

export type SourceState =
    | {
        kind: "plain-directory";
        repositoryId: string;
        indexingRoot: string;
    }
    | {
        kind: "git";
        context: SourceControlContext;
        state: WorkingTreeState;
    };
