# Documentation

Documentation is a named, managed retrieval corpus whose resources live under
`~/.scribery/documentations`. It is independent of any Git working tree and may
contain files from unrelated locations or documents supplied directly by another
local application.

The documentation model has three levels:

- documentation is the retrieval and active-build boundary;
- a source is one independently managed external identity;
- a document revision is the exact content and retrieval metadata indexed for a
  source.

Source upserts are idempotent by `externalId`. Scribery derives a stable
`sourceId`, stores the exact supplied bytes in its managed directory, and records
the source's logical path, title, media type, tags, and optional encoding. Removing
a source changes documentation membership but does not mutate immutable historical
index builds. Generic scalar source attributes are preserved in retrieval results
for future chat identifiers, roles, timestamps, and adapter-specific provenance.

Source changes increment `sourcesRevision`. Retrieval is disabled until a ready
build has atomically become active for that exact revision, preventing a chat from
silently querying stale source membership. Compatible unchanged documents reuse
their chunks and embeddings.

Tags are source metadata with four atomic mutations: `set`, `add`, `remove`, and
`clear`. Mutations may target multiple sources, fail before writing when any
source is unknown, and are idempotent when the normalized tag sets do not change.
An actual tag change increments `sourcesRevision`, so tag-filtered retrieval cannot
use stale indexed metadata.

Documentation indexing uses cAST whenever a registered code parser supports the
classified format. Other decoded text uses the deterministic overlapping
`sliding-window` strategy. Binary, unknown, empty, and oversized sources produce
diagnostics rather than embeddings.

`ManagedDocumentationSourceProvider` converts the documentation manifest and copied
bytes into the same prepared-source contract used by project indexing. The
documentation package injects its classification, decoding, parser, and
chunking runtime into the shared `IndexBuildEngine`. Core then owns build
orchestration, reuse, embeddings, storage, and publication; documentation does not
maintain a parallel indexing pipeline.

Retrieval accepts an optional hard source scope. An omitted scope searches the
whole documentation, while an explicitly empty source or tag list returns no results.
Source and tag filters are applied by storage before ranking or reranking.

`DocumentationService` is the transport-neutral API for future adapters. It exposes
documentation creation, listing, and deletion; `upsertDocuments`, `listSources`,
`removeSources`; `setSourceTags`, `addSourceTags`, `removeSourceTags`, and
`clearSourceTags`; `buildDocumentation`, active-build resolution, and `retrieve`.
Callers do not need to know the SQLite path or immutable build IDs. Deleting
documentation removes its entire managed directory, including copied source bytes,
its database, and immutable historical builds.
