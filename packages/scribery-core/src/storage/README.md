# Storage

This directory contains the persistent storage abstractions and storage-provider
implementations used by indexing and retrieval.

Storage preserves repositories, snapshots, file revisions, chunks, embeddings,
metadata, and the relationships between them.

## Core design decisions

- Storage is provider-independent at the application boundary.
- Chunks, embeddings, and snapshot membership are separate records.
- Identical file revisions, chunks, and embeddings may be reused across snapshots.
- Incomplete index builds must never be visible to normal retrieval.
- Every vector must retain its complete embedding model identity.
- Snapshot and index-build membership are hard retrieval constraints.
- Schema versions and migrations must be explicit.
- Persistent writes should be idempotent where practical.
- Chunk content must remain available even when the working tree changes versions.

## Responsibilities

The storage subsystem is responsible for:

- persisting repository records;
- persisting source snapshots and aliases;
- persisting index builds and their exact processing configuration;
- persisting file revisions;
- persisting exact chunk content and metadata;
- persisting embedding vectors and model identities;
- recording snapshot-to-file membership;
- recording build-to-document and build-to-chunk membership;
- associating embeddings with chunks;
- supporting metadata-filtered vector search;
- optionally supporting lexical search;
- tracking index-build state;
- publishing complete index builds atomically;
- supporting incremental updates and deduplication;
- removing unreachable data safely;
- validating storage compatibility;
- managing storage schema migrations;
- supporting crash recovery.

## Non-responsibilities

The storage subsystem does not:

- discover files;
- inspect source-control state;
- classify documents;
- split documents into chunks;
- generate embeddings;
- decide which retrieval mode to use;
- rerank candidates;
- resolve the current project version;
- construct LLM prompts;
- expose MCP tools.

Storage executes validated persistence and search operations. Higher-level
subsystems decide what should be indexed and how results should be ranked.

## Stored entities

The initial storage model should distinguish the following entities.

### Repository

Represents one logical source repository or non-source-controlled indexing root.

```ts
export interface StoredRepository {
    repositoryId: string;
    sourceControl: "git" | "none";
    createdAt: string;
    metadataSchemaVersion: number;
}
```

### Snapshot

Represents one immutable committed, working-tree, or directory source state. Its
identity does not depend on classification, chunking, formatting, or embedding
configuration.

```ts
export interface StoredSnapshot {
    snapshotId: string;
    repositoryId: string;
    sourceSelectionHash: string;

    kind: "git-commit" | "working-tree" | "directory";
    baseCommit?: string;
    createdAt: string;
}
```

The source snapshot is complete once its selected file-membership set has been
recorded.
Processing the same snapshot with another configuration does not create another
snapshot.

### Index build

Represents one attempt to process a source snapshot using one exact configuration.

```ts
export interface StoredIndexBuild {
    indexBuildId: string;
    repositoryId: string;
    snapshotId: string;

    indexingConfigurationHash: string;
    applicationVersion: string;
    metadataSchemaVersion: number;
    chunkingIdentity: ChunkingIdentity;
    embeddingModelIdentity: EmbeddingModelIdentity;

    status: "building" | "ready" | "failed" | "cancelled";
    createdAt: string;
    completedAt?: string;
    failure?: StorageFailure;
}
```

Only builds with `status: "ready"` may be used by normal retrieval. A ready build
is immutable.

### Ref alias

Represents a mutable name pointing to a snapshot.

```ts
export interface StoredRefAlias {
    repositoryId: string;
    name: string;
    kind: "branch" | "tag" | "project-version" | "other";
    snapshotId: string;
    updatedAt: string;
}
```

Moving a branch should update this alias rather than rewriting every chunk.

### File revision

Represents one exact source-byte revision. Classification and decoding results are
build artifacts rather than properties of the byte identity.

```ts
export interface StoredFileRevision {
    fileRevisionId: string;
    byteContentHash: string;
    byteLength: number;
}
```

File revisions can be shared across snapshots.

### Snapshot file membership

Associates a path within a snapshot with a file revision.

```ts
export interface StoredSnapshotFile {
    snapshotId: string;
    path: string;
    fileRevisionId: string;
}
```

This relationship allows identical files to be reused without storing branch-name
arrays on every chunk.

### Index-build document

Associates build-specific classification and document metadata with one path and
source file revision.

```ts
export interface StoredIndexBuildDocument {
    indexBuildId: string;
    documentId: string;
    snapshotId: string;
    path: string;
    fileRevisionId: string;
    metadata: DocumentMetadata;
}
```

This separation allows the same source bytes to be reclassified or decoded under a
new build configuration without mutating the file revision or source snapshot.

### Chunk

Represents one exact chunk generated from a file revision.

```ts
export interface StoredChunk {
    chunkId: string;
    fileRevisionId: string;

    content: string;
    contentHash: string;
    metadata: ChunkMetadata;

    chunkingIdentity: ChunkingIdentity;
}
```

Exact chunk content should be stored. Retrieval cannot rely on reading the current
working tree because the user may have switched to another version since indexing.

### Embedding

Represents one vector created from one exact formatted embedding input.

```ts
export interface StoredEmbedding {
    embeddingId: string;
    inputHash: string;

    vector: Float32Array;
    modelIdentity: EmbeddingModelIdentity;

    createdAt: string;
}
```

### Chunk embedding association

Associates a chunk with a compatible embedding.

```ts
export interface StoredChunkEmbedding {
    chunkId: string;
    embeddingId: string;
}
```

Keeping this association separate permits reuse when several chunks produce the
same formatted embedding input.

### Index-build chunk membership

Associates the chunks selected for one build with that build. This relationship is
required because two builds of the same source snapshot may use different chunking
configurations.

```ts
export interface StoredIndexBuildChunk {
    indexBuildId: string;
    documentId: string;
    chunkId: string;
}
```

## Relationships

The conceptual relationship is:

```text
Repository
    ├── Ref aliases
    └── Snapshots
        └── Snapshot file memberships
              └── File revisions

Snapshot
    └── Index builds
          └── Index-build documents
                └── Index-build chunk memberships
                      └── Chunks
                            └── Embeddings
```

A file revision may belong to many snapshots or paths. A chunk may therefore be
reachable through many index-build document memberships without duplicating its
content or vector. The membership's `documentId` preserves each source attribution.

## Storage interfaces

The application-facing API should be separated by capability rather than represented
as one very large class.

```ts
export interface StorageProvider {
    repositories: RepositoryStore;
    snapshots: SnapshotStore;
    builds: IndexBuildStore;
    documents: DocumentStore;
    chunks: ChunkStore;
    embeddings: EmbeddingStore;
    search: SearchStore;
    maintenance: MaintenanceStore;
}
```

Providers may implement all capabilities using one database or compose several
storage technologies.

For example:

- relational or document storage for metadata and membership;
- vector storage for semantic search;
- a text index for lexical search.

These implementation details must remain behind the storage interfaces.

## Repository operations

```ts
export interface RepositoryStore {
    get(repositoryId: string): Promise<StoredRepository | null>;

    put(
        repository: StoredRepository,
    ): Promise<void>;

    list(): AsyncIterable<StoredRepository>;
}
```

`put` should be idempotent when the existing record is compatible.

## Snapshot and build operations

```ts
export interface SnapshotStore {
    put(snapshot: StoredSnapshot): Promise<void>;

    get(snapshotId: string): Promise<StoredSnapshot | null>;

    resolveAlias(
        repositoryId: string,
        alias: string,
    ): Promise<StoredRefAlias | null>;

    updateAlias(
        alias: StoredRefAlias,
    ): Promise<void>;
}

export interface IndexBuildStore {
    begin(build: StoredIndexBuild): Promise<void>;

    markReady(indexBuildId: string): Promise<void>;

    markFailed(
        indexBuildId: string,
        reason: StorageFailure,
    ): Promise<void>;

    markCancelled(indexBuildId: string): Promise<void>;

    get(indexBuildId: string): Promise<StoredIndexBuild | null>;

    addChunks(memberships: StoredIndexBuildChunk[]): Promise<void>;
}
```

Marking an index build ready must atomically publish its complete searchable
membership to readers.

## Document operations

```ts
export interface DocumentStore {
    putFileRevisions(revisions: StoredFileRevision[]): Promise<void>;

    putSnapshotFiles(memberships: StoredSnapshotFile[]): Promise<void>;

    putBuildDocuments(documents: StoredIndexBuildDocument[]): Promise<void>;

    getFileRevision(
        fileRevisionId: string,
    ): Promise<StoredFileRevision | null>;
}
```

File revisions and snapshot memberships are source facts. Build documents are
derived processing records and must reference an existing build, snapshot
membership, and file revision.

## Chunk operations

```ts
export interface ChunkStore {
    get(chunkId: string): Promise<StoredChunk | null>;

    putMany(chunks: StoredChunk[]): Promise<void>;

    getMany(chunkIds: string[]): Promise<StoredChunk[]>;

    listForFileRevision(
        fileRevisionId: string,
    ): AsyncIterable<StoredChunk>;
}
```

Batch operations should preserve input association and report partial failures
explicitly.

## Embedding operations

```ts
export interface EmbeddingStore {
    findByInput(
        inputHash: string,
        model: EmbeddingModelIdentity,
    ): Promise<StoredEmbedding | null>;

    putMany(
        embeddings: StoredEmbedding[],
    ): Promise<void>;

    associate(
        associations: StoredChunkEmbedding[],
    ): Promise<void>;
}
```

Embedding lookup must include the complete model identity. An input hash alone is
not sufficient.

## Search operations

```ts
export interface SearchStore {
    vectorSearch(
        request: VectorSearchRequest,
    ): Promise<VectorSearchResult[]>;

    lexicalSearch?(
        request: LexicalSearchRequest,
    ): Promise<LexicalSearchResult[]>;
}
```

A vector search request should contain:

```ts
export interface VectorSearchRequest {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;

    vector: Float32Array;
    modelIdentity: EmbeddingModelIdentity;

    filters?: StorageFilter;
    limit: number;
    signal?: AbortSignal;
}
```

Repository, snapshot, and ready index-build requirements must not be optional in
the normal search method. Cross-snapshot or cross-build search should use a
separate explicit operation or request type.

## Search results

```ts
export interface VectorSearchResult {
    chunkId: string;
    documentId: string;
    fileRevisionId: string;
    snapshotId: string;
    indexBuildId: string;
    path: string;

    rawScore: number;
    scoreKind: "similarity" | "distance";
    metric: VectorMetric;
}
```

Storage should report the raw backend score and its meaning. Retrieval decides how
scores are normalized, fused, or reranked.

## Vector compatibility

Before vector insertion or search, storage must validate:

- model identity;
- vector dimensions;
- vector metric;
- normalization requirements;
- vector value validity;
- index compatibility.

Vectors with incompatible model identities must not be mixed within the same
logical vector index.

If the backend requires one dimension per collection, the adapter should select or
create the correct internal collection based on model identity.

## Distance metrics

Supported distance metrics may include:

```ts
export type VectorMetric =
    | "cosine"
    | "dot-product"
    | "euclidean";
```

The metric must be stored as part of index compatibility metadata.

Storage adapters must not silently substitute one metric for another.

## Filters

Storage filters are produced from the provider-independent retrieval filter model.

Adapters are responsible for translating canonical filters into backend operations.

They must not accept raw:

- SQL;
- backend JSON expressions;
- regular expressions, unless explicitly supported and validated;
- collection names;
- arbitrary backend field names.

Unsupported filter operations should return an explicit capability error.

## Incremental indexing

Storage should support checking whether work already exists before repeating it.

Examples include:

- file revision already stored by byte-content hash;
- build document metadata already stored for the same build and file revision;
- chunks already generated for the same file revision and chunking identity;
- embedding already generated for the same formatted input and model identity;
- snapshot file membership already present;
- index-build chunk membership already present.

An incremental indexing coordinator can then skip unnecessary work.

Modification time may be used as a hint, but content identity must ultimately be
verified using hashes.

The implemented coordinator keeps the exact build-configuration hash separate
from an artifact-compatibility hash. Whole-document reuse additionally verifies
the file's byte revision, resolved encoding, language and format, parser identity,
chunking identity, and embedding-model identity. Embeddings have an independent
content-addressed lookup, so a compatible vector is linked into the new build
before any provider request even when the enclosing document must be reprocessed.
Whole-document candidates are staged and resolved together; all compatible document
and chunk-membership copies are committed in one transaction before decoding misses.

## Chunks

Reuse when all of the following match:

- file revision;
- chunking strategy identity;
- chunking configuration;
- source range;
- chunk content.

## Embeddings

Reuse when all of the following match:

- exact formatted embedding input;
- formatter version;
- embedding provider and model;
- model revision;
- vector dimensions;
- task mode;
- normalization and metric configuration.

Branch or version names should not affect embedding identity unless they are
deliberately included in the formatted embedding input.

SQLite semantic search streams the scoped embedding rows and retains only the
requested best candidates in memory. Document and chunk content is hydrated only
for those candidates; a large index is never materialized as one JavaScript
array.

## Persistence location

The storage location should be configurable.

The current CLI stores managed indexes under
`~/.scribery/indexes/<project-identifier>/`. Each managed project directory
contains `index.sqlite`, a source-root manifest for newly created indexes, and a
`logs/` directory for build diagnostics. CLI project deletion removes this entire
managed directory; explicitly configured `--db` paths remain caller-managed.

Ready builds expose document-scoped chunk inspection by normalized relative path.
Results contain the stored document and its exact chunks ordered by canonical
source index; build membership prevents chunks from another snapshot from being
returned.

Possible defaults include:

- a device-level application data directory;
- a project-local `.scribery/` directory;
- an explicitly configured database path;
- a remote storage service.

Project-local storage makes repository association simple but may be large and
should normally be excluded from source control and discovery.

Storage must not accidentally index its own database or vector files.

## Errors

Storage errors should distinguish between:

- record not found;
- identifier collision;
- incompatible schema;
- incompatible embedding model;
- invalid vector;
- unsupported filter;
- unavailable provider;
- permission failure;
- lock contention;
- transaction failure;
- storage corruption;
- insufficient disk space;
- migration failure;
- cancellation;
- timeout.

Errors should identify record IDs and operations without including complete chunk
contents.

## Testing

Tests should cover:

- repository creation;
- building, ready, failed, and cancelled index builds;
- invisibility of non-ready index builds;
- snapshot membership isolation;
- index-build membership isolation;
- identical files shared by multiple snapshots;
- branch alias movement;
- dirty working-tree snapshots;
- idempotent batch writes;
- prepared-statement reuse and one transaction per chunk/embedding batch;
- identifier collisions;
- chunk and embedding reuse;
- incompatible model identities;
- incorrect vector dimensions;
- metadata filters;
- unsupported filter capabilities;
- interrupted indexing;
- concurrent readers and writers;
- process locking;
- snapshot deletion;
- reachability-based garbage collection;
- migration success and failure;
- storage corruption detection;
- cancellation and timeout;
- paths containing non-ASCII characters.

Version-isolation tests should ensure that a highly relevant vector from another
snapshot or index build is never returned.

## MVP contract

The first implementation includes:

- repositories, immutable source snapshots, and snapshot file memberships;
- index-build lifecycle and atomic ready publication;
- file revisions, build documents, chunks, embeddings, and explicit associations;
- one in-memory provider for contract tests;
- one persistent local provider;
- atomic bulk copying of compatible ready-build documents and chunk memberships into
  a new building index;
- metadata-filtered semantic search scoped by repository, snapshot, and build;
- exact-build, same-document chunk-neighborhood lookup for context expansion;
- strict model and vector validation;
- deterministic ordering for equal scores.

Lexical indexes, migrations, garbage collection, concurrent process locking,
cross-snapshot deduplication optimization, and interrupted-build resume are later
work.

## Implemented layout

- `contracts/` — build, document, chunk, embedding, filter, neighborhood, and
  provider types;
- `providers/in-memory/` — deterministic contract-test provider;
- `providers/sqlite/` — persistent local SQLite provider with atomic build
  publication;
- `utils/` — filter evaluation and cosine similarity;
- `errors/` — structured storage failures;
- `testing/` — shared provider contract and version-isolation tests.
