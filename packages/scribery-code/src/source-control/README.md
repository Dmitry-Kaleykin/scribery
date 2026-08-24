# Source Control

This directory contains integrations with source-control systems.

The initial implementation supports Git. The subsystem detects repository context,
resolves immutable source snapshots, and reports working-tree state to the indexing
pipeline.

## Core design decisions

- Git commit hashes identify immutable committed snapshots.
- Branches and tags are mutable aliases, not snapshot identities.
- Dirty working-tree content must not be labeled as the unchanged HEAD commit.
- Source-control inspection must never modify the repository.
- Source-control operations must not perform network access automatically.
- Git object IDs and application content hashes are separate concepts.
- Retrieval should use resolved snapshot IDs rather than branch names alone.

## Responsibilities

The source-control subsystem is responsible for:

- detecting whether an indexing root belongs to a source-control repository;
- locating the repository root;
- identifying the source-control provider;
- reading the current commit;
- reading the current branch or detached-HEAD state;
- detecting staged, unstaged, deleted, and untracked changes;
- resolving branches and tags to commits;
- listing or validating refs when requested;
- reporting worktree and repository context;
- exposing Git-aware ignore information to discovery;
- returning structured source-control diagnostics.

## Non-responsibilities

The source-control subsystem does not:

- switch branches;
- create, modify, or delete refs;
- stage or commit changes;
- fetch, pull, push, or contact remotes;
- discover ordinary files recursively;
- read complete source documents for indexing;
- classify or chunk documents;
- construct final working-tree content hashes;
- store repository metadata permanently;
- choose the retrieval scope;
- execute retrieval filters.

The indexing coordinator combines source-control context with discovered and hashed
file revisions to construct a complete snapshot.

## Provider interface

Source-control implementations should expose a provider-independent interface:

```ts
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

    isIgnored?(
        context: SourceControlContext,
        paths: string[],
        options?: SourceControlOptions,
    ): Promise<IgnoreResult[]>;
}
```

Returning `null` from `detect` means the path is not managed by a supported
source-control system. This is a normal result, not an error.

The exact types may evolve as the implementation develops.

## Repository context

Repository context should distinguish the indexing root from the repository root.

```ts
export interface SourceControlContext {
    provider: "git";
    repositoryId: string;

    repositoryRoot: string;
    indexingRoot: string;
    indexingRootRelativePath: string;

    worktreeRoot: string;
    commonDirectory?: string;
}
```

These paths serve different purposes:

- repositoryRoot identifies the repository checkout;
- indexingRoot is the directory requested by the user;
- indexingRootRelativePath locates that directory inside the repository;
- worktreeRoot identifies the current Git worktree;
- commonDirectory may be shared by multiple Git worktrees.

An indexing root may be a subdirectory of a repository. The source-control
subsystem must not assume that indexing always begins at the repository root.

## Repository identity

Repository identity must not depend solely on:

- the current branch;
- an absolute filesystem path;
- a remote URL;
- the repository directory name.

Remote URLs can change, may contain credentials, and may identify multiple local
worktrees or forks ambiguously.

The initial implementation may use a locally generated repository identifier stored
in the index configuration. The identity algorithm must be documented and stable.

Multiple Git worktrees should normally share a repository identity while retaining
separate worktree state.

## Current Git state

The current state should report:

```ts
export interface WorkingTreeState {
    repositoryId: string;

    headCommit?: string;
    refName?: string;
    detached: boolean;
    unborn: boolean;

    dirty: boolean;
    changes: WorkingTreeChange[];
}
```
A repository may have no commit yet. This is an unborn repository and must not be
treated as an error.

A detached `HEAD` has a commit but no current branch name.

## Working-tree changes

Working-tree changes should distinguish at least:

```ts
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
```

A path may contain both staged and unstaged changes.

The indexing pipeline reads working-tree files from disk. Therefore, the resulting
snapshot describes actual working-tree contents, not only Git's staging area.

Git status information helps identify changes, but it is not a substitute for
hashing the content that is actually indexed.

## Snapshots

For a clean working tree, the Git commit may be used to construct the source
snapshot identity:

`git:<repository-id>:<source-selection-hash>:<commit>`

For a dirty working tree, the `HEAD` commit is only the base snapshot. The final
snapshot identity must also represent changed, deleted, and untracked files.

A conceptual dirty snapshot identity is:

```text
working-tree:<repository-id>:<selection-hash>:<base-commit>:<fingerprint>
```

The source-control subsystem reports the base commit and changed paths. The indexing
coordinator calculates the final content fingerprint after discovery and content
hashing.

This avoids hashing the entire working tree twice.

Source snapshot identity never contains classifier, chunker, formatter, or
embedding configuration. Those values identify an index build for the snapshot.

## Refs and version aliases

Branches and tags should be represented as aliases resolving to commits:

```ts
export interface ResolvedRef {
    repositoryId: string;
    refName: string;
    refType: "branch" | "tag" | "other";
    commit: string;
}
```

A project-specific version name may also resolve to a snapshot, but its mapping
should be supplied by configuration or a dedicated version resolver.

Mutable aliases should be refreshed when repository state changes. Moving a branch
should update its alias record without rewriting every chunk.

## Ignore handling

Discovery owns the decision to include or exclude filesystem paths.

The source-control subsystem may expose Git-compatible ignore evaluation so that
discovery can respect:

- .gitignore;
- repository exclude files;
- configured global Git excludes, if enabled.

Ignore behavior must be explicit because global ignore configuration differs
between machines.

The default should prioritize reproducible repository rules. Machine-specific
global ignore rules should only be used when configured.

## Nested repositories

An indexing root may contain another repository.

The behavior must be configurable. Possible policies include:

- stop at nested repository boundaries;
- treat nested repositories as independent repositories;
- include nested contents as ordinary files.

The initial implementation should stop at nested repository boundaries and report
them through diagnostics.

## Submodules

Git submodules require explicit handling.

A submodule entry identifies another repository and commit. The parent repository's
snapshot does not by itself contain the submodule's file contents.

The initial implementation may:

- skip submodule contents;
- report the submodule path and referenced commit;
- require the submodule to be indexed separately.

Submodules must not be silently treated as normal directories.

## Worktrees

Multiple Git worktrees may share repository objects and refs while having different:

- checked-out commits;
- branches;
- uncommitted changes;
- filesystem roots.

Repository identity and worktree identity must therefore remain separate.

Queries should resolve the snapshot for the worktree currently being indexed, not
assume that one repository has only one active checkout.

## Command execution

Git commands must be executed without invoking a shell.

Arguments must be passed as an argument array to avoid interpreting repository paths
or ref names as shell syntax.

Commands should:

- set an explicit working directory;
- use machine-readable output where available;
- avoid localized human-readable output;
- use -- before path arguments where applicable;
- have bounded execution time;
- support cancellation;
- capture standard error safely;
- never include file contents in diagnostics by default.

The subsystem must not run commands that mutate the repository.

## Network and hooks

Source-control inspection must be local and read-only.

It must not automatically:

- fetch missing refs;
- initialize or update submodules;
- contact remotes;
- run checkout operations;
- run user-defined automation.

If a future operation requires network access or repository mutation, it must be a
separate explicit user action.

## Cancellation

Operations should accept an AbortSignal:

```ts
export interface SourceControlOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
```

Cancellation should terminate active Git processes and prevent additional commands
from starting.

## Errors and diagnostics

Errors should distinguish between:

- unsupported source-control provider;
- repository not found;
- Git executable unavailable;
- invalid or ambiguous ref;
- missing object;
- permission failure;
- command timeout;
- cancellation;
- corrupt repository;
- unexpected Git output.

A directory that is not inside a repository is a normal condition and should not
produce an error.

Diagnostics may include:

- repository-relative path;
- Git command category;
- exit code;
- ref name;
- commit hash.

Diagnostics must not expose credentials embedded in remote URLs or complete file
contents.

## Testing

Tests should cover:

- directories outside Git repositories;
- clean repositories;
- modified, staged, and untracked files;
- deleted and renamed files;
- files with both staged and unstaged changes;
- detached HEAD;
- unborn repositories;
- indexing a repository subdirectory;
- branch and tag resolution;
- branch movement;
- paths containing spaces and non-ASCII characters;
- multiple Git worktrees;
- nested repositories;
- submodules;
- command timeout and cancellation;
- Git executable unavailable.

Tests must create temporary repositories and must not depend on the developer's
global Git configuration.

## MVP contract

The first implementation includes:

- detecting whether the indexing root is inside a Git repository;
- distinguishing repository root from indexing root;
- current commit, branch, detached HEAD, and unborn-repository state;
- clean versus dirty status with staged, unstaged, deleted, and untracked paths;
- resolving an explicitly requested local branch or tag;
- safe argument-based Git execution with timeout and cancellation;
- no network access and no repository mutation.

Dirty snapshot fingerprint construction belongs to the Git working-tree source
adapter, which combines this subsystem's provenance with filesystem membership.
Multiple worktree optimization, nested repositories, submodule indexing, ignore
evaluation through Git, and ref enumeration are later work.

## Implemented layout

- `contracts/` — provider-independent context, state, ref, and change types;
- `inspect-source-state.ts` — public convenience inspection with a
  plain-directory fallback;
- `providers/git/git-provider.ts` — repository detection, state inspection, status
  parsing, and ref resolution;
- `providers/git/run-git.ts` — safe argument-based process execution, timeout,
  and cancellation;
- `errors/` — structured source-control failures;
- `testing/` — temporary repositories independent of global Git configuration.

Ref enumeration, worktree optimization, and Git-object reuse can be added later.

---

One especially important boundary is:

```text
source-control:
    HEAD is abc123, branch is version-12, worktree is dirty

indexing coordinator:
    these exact file revisions form working-tree snapshot XYZ

metadata:
    defines and validates snapshot XYZ and its memberships

retrieval:
    restrict search to snapshot XYZ
```
