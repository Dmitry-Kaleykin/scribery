# Documentation

Documentation is a named retrieval corpus stored under
`~/.scribery/documentations`. A corpus is independent of projects and Git working
trees. Its source configuration can combine:

- live directories, discovered recursively whenever the corpus is indexed; and
- managed documents whose exact supplied bytes are copied into Scribery.

The manifest uses schema version 2 and stores source definitions rather than a
materialized directory listing. A directory definition records its absolute root,
logical mount path, include/exclude rules, hidden-file and gitignore behavior,
size limit, tags, and scalar attributes. A managed definition records a stable
external identity, copied content hash, logical path, media type, and metadata.
There is intentionally no schema-v1 migration because no deployed documentation
catalog needs one.

`indexDocumentation` is the only indexing operation. Each call discovers the
current contents of every configured directory and reads managed documents, then
constructs one immutable source snapshot. Added, changed, and deleted files are
therefore handled identically. The shared `IndexBuildEngine` reuses a complete
build when the snapshot is identical and otherwise reuses compatible unchanged
documents, chunks, and embeddings.

After storage finishes, Scribery atomically publishes the build together with its
exact indexed-file inventory. Each entry has a stable file-level `sourceId`, its
parent `sourceDefinitionId`, logical path, content hash, tags, and provenance.
Retrieval and source filters use this active inventory, so a nested file returned
by search remains traceable to the configured directory that owns it.

Changing source configuration increments `configurationRevision`. Retrieval is
disabled until an index for that exact revision becomes active. Filesystem changes
do not require a separate revision or synchronization action: the next ordinary
index call observes them and publishes the resulting snapshot.

Tags belong to source definitions and are inherited by every discovered file.
The `set`, `add`, `remove`, and `clear` mutations are atomic and idempotent.

Documentation indexing uses cAST for supported code and deterministic overlapping
windows for other decoded text. Binary, unknown, empty, and oversized files produce
diagnostics rather than embeddings. The MCP layer remains read-only; configuration
and indexing are performed through the service, CLI, or TUI.
