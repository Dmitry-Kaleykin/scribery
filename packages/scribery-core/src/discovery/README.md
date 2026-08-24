# Discovery

This directory contains the logic used to discover files within an indexing root.

Discovery determines which filesystem entries are candidates for the indexing
pipeline. It does not inspect or interpret file contents.

## Responsibilities

The discovery subsystem is responsible for:

- recursively traversing an indexing root;
- identifying regular files, directories, and symbolic links;
- applying path-based include and exclude rules;
- respecting configured ignore files;
- preventing traversal outside the indexing root;
- collecting basic filesystem metadata;
- reporting inaccessible or invalid entries;
- yielding discovered files in a deterministic order.

Discovered files are passed to later stages for classification, decoding, chunking,
embedding, and storage.

## Non-responsibilities

The discovery subsystem does not:

- determine whether a file is text or binary;
- detect programming languages or text encodings;
- read complete file contents;
- split files into chunks;
- generate embeddings;
- store file or chunk records;
- make content-based indexing decisions.

Discovery may exclude a path because it matches an ignore rule. It should not
exclude a file because its contents appear generated, minified, or unimportant.

## Common interface

Discovery exposes files and recoverable diagnostics through one asynchronous event
stream:

```ts
export type DiscoveryEvent =
    | { type: "file"; file: DiscoveredFile }
    | { type: "diagnostic"; diagnostic: DiscoveryDiagnostic };

export interface FileDiscovery {
    discover(
        root: string,
        options: DiscoveryOptions,
    ): AsyncIterable<DiscoveryEvent>;
}
```

A fatal root-level error rejects iteration. A recoverable error for one entry emits
a diagnostic and allows traversal to continue.

## Discovered files

A discovered file should contain at least:

```ts
export interface DiscoveredFile {
    absolutePath: string;
    relativePath: string;
    size: number;
    modifiedAt: Date;
}
```

Additional filesystem information may include:

- creation time, when reliably available;
- file mode or permissions;
- inode or platform-specific file identity;
- symbolic-link information;
- source indexing root.

## Discovery options

Initial options may include:

```ts
export interface DiscoveryOptions {
    include?: string[];
    exclude?: string[];
    useGitignore?: boolean;
    followSymbolicLinks?: boolean;
    includeHidden?: boolean;
    maxFileSize?: number;
    signal?: AbortSignal;
}
```

## Path handling

Paths should be normalized consistently.

Discovery must correctly handle:

- relative and absolute indexing roots;
- spaces and non-ASCII characters;
- hidden files and directories;
- extensionless files;
- dotfiles;
- platform-specific path separators;
- case-sensitive and case-insensitive filesystems;
- paths that disappear during traversal.

## Errors and diagnostics

A problem with one entry should not normally stop the entire indexing run.

Recoverable conditions include:

- permission denied;
- broken symbolic link;
- file removed during traversal;
- unreadable directory;
- path exceeding configured limits;
- file exceeding the maximum size;
- unsupported filesystem entry type.

These conditions should produce structured diagnostics.

```ts
export interface DiscoveryDiagnostic {
    path: string;
    code: string;
    message: string;
    severity: "warning" | "error";
}
```

## Performance

Discovery should:

- stream file candidates;
- avoid loading the entire directory tree into memory;
- limit concurrent filesystem operations;
- avoid reading file contents;
- avoid descending into excluded directories;
- support cancellation for long-running indexing operations.

## Cancellation

Long discovery operations accept an `AbortSignal` through `DiscoveryOptions`.
Cancellation ends iteration by throwing a structured cancellation error; it must
not be reported as successful exhaustion.

## MVP contract

The first implementation includes:

- deterministic recursive traversal of one indexing root;
- regular files and directory handling;
- `.gitignore` plus explicit include and exclude patterns;
- hidden-file and maximum-file-size options;
- symbolic links skipped with a diagnostic;
- bounded filesystem concurrency;
- file and diagnostic events;
- cancellation.

Following symbolic links, nested-repository policies, global Git excludes, inode
identity, and filesystem watchers are later work.

## Implemented layout

- `contracts/` — discovery options, files, diagnostics, events, and interface;
- `discover-files.ts` — deterministic traversal, root `.gitignore`, explicit
  patterns, limits, symlink policy, and cancellation;
- `errors/` — structured fatal discovery failures;
- `testing/` — ordering, ignore, include, and symlink coverage.
