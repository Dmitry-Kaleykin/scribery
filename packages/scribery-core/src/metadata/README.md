# Metadata

This directory contains the shared metadata model used throughout the indexing and
retrieval pipelines.

Metadata describes where indexed content came from, how it was processed, and how
it can be filtered or traced back to its source.

## Core design decisions

- Stored metadata must be versioned.
- Persistent paths must be relative to an indexing root.
- Absolute paths must not be used as stable identities.
- Document and chunk identifiers must be deterministic.
- Metadata used for filtering must have a stable, provider-independent schema.
- Every derived value should retain enough provenance to explain its origin.
- Original document content and chunk content are not metadata.

## Responsibilities

The metadata subsystem is responsible for:

- defining document, chunk, and indexing metadata schemas;
- constructing deterministic document and chunk identifiers;
- normalizing metadata values;
- validating metadata before storage;
- merging metadata produced by different pipeline stages;
- tracking metadata schema versions;
- identifying fields available for filtering;
- preserving provenance for derived metadata;
- supporting incremental indexing and change detection.

## Non-responsibilities

The metadata subsystem does not:

- discover files;
- read file contents;
- classify files directly;
- split documents into chunks;
- generate embeddings;
- store records permanently;
- execute metadata filters;
- rank retrieval results.

Other subsystems produce metadata values. This subsystem defines, validates, and
combines those values.

## Metadata levels

Metadata should be separated by scope.

### Index-build metadata

Describes one processing of an immutable source snapshot with an exact
configuration.

Possible fields include:

- index-build identifier;
- repository and snapshot identifiers;
- normalized root identity;
- indexing configuration hash;
- indexing start and completion times;
- application version;
- metadata schema version;
- chunking configuration version;
- embedding model identity.

### Document metadata

Describes a source document.

Possible fields include:

- document identifier;
- normalized relative path;
- filename;
- extension;
- byte length;
- modification time;
- source-byte content hash;
- decoded-content hash, for text accepted by policy;
- content kind;
- format;
- language;
- encoding;
- classification confidence;
- file traits;
- indexing root identifier;
- optional managed-documentation source ID, title, media type, and tags.

For initial builds, `encoding` is the decoder's final canonical label, either
`utf-8` or `windows-1251`; configuration aliases are never persisted.

### Chunk metadata

Describes one chunk within a document.

Possible fields include:

- chunk identifier;
- file-revision identifier;
- chunk index;
- chunk content hash;
- start and end offsets;
- start and end lines;
- chunk kind;
- symbol name;
- symbol kind;
- parent symbols;
- chunking strategy;
- chunking strategy version;
- strategy-specific metadata.

### Processing metadata

Describes how a stored artifact was produced.

Possible fields include:

- metadata schema version;
- application version;
- processing timestamp;
- classifier version;
- chunker version;
- formatter version;
- embedding model identity.
- managed source ID and source tags.

Processing metadata makes it possible to determine whether an artifact must be
reclassified, rechunked, or re-embedded.

Processing metadata is stored on the index-build or derived-artifact record it
describes, not inside reusable canonical `DocumentMetadata`. Embedding identity is
stored with the embedding record; the index build records which embedding identity
it selected.

## Suggested types

```ts
export interface DocumentMetadata {
    schemaVersion: number;
    documentId: string;

    path: string;
    filename: string;
    extension?: string;

    byteLength: number;
    modifiedAt?: string;
    byteContentHash: string;
    decodedContentHash?: string;

    contentKind: "text" | "binary" | "unknown";
    format?: string;
    language?: string;
    encoding?: string;
    parserId?: string;
    traits: string[];

    classification?: ClassificationMetadata;
}

export interface ChunkMetadata {
    schemaVersion: number;
    chunkId: string;
    fileRevisionId: string;

    index: number;
    contentHash: string;

    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;

    kind?: string;
    symbol?: SymbolMetadata;
    chunking: ChunkingMetadata;
}
```

Canonical document metadata describes the source and its classification. It does
not contain build timestamps, chunker versions, formatter versions, or embedding
identity. Those values belong to index-build records, chunking identities, and
embedding records. This prevents a reusable source artifact from pretending it was
produced by only one processing run.

## Identity construction

Identity constructors use a canonical length-prefixed encoding rather than joining
fields with an ambiguous delimiter. Every identifier includes a type namespace and
an identity-schema version before its fields are hashed.

The initial ownership rules are:

- `repositoryId` is a stable configured identifier for the logical repository;
- `snapshotId` hashes repository identity plus either an immutable clean
  source-control revision and source-selection hash or, for working-tree and
  plain-directory snapshots, the selection hash plus complete normalized source
  membership needed to identify that state;
- `indexBuildId` hashes repository, snapshot, configuration, application, and
  metadata-schema identities;
- `fileRevisionId` hashes the exact source bytes and byte-hash algorithm identity;
- `documentId` hashes repository identity, indexing-root identity, and normalized
  logical path;
- `chunkId` hashes file revision, chunking identity, source range, and exact chunk
  content hash;
- the embedding-input correlation ID hashes document and chunk identity so one
  build can embed identical content at multiple logical paths;
- `embeddingId` hashes the exact formatted embedding input plus complete embedding
  model identity.

Membership records, rather than IDs, express that a file, document, or chunk is
part of a particular snapshot or build. Identity functions must be covered by
golden fixtures so changing serialization or hash algorithms is a deliberate
schema change.

## More on content hashes

Document and chunk content hashes support:

- incremental indexing;
- detecting changed files;
- avoiding unnecessary embedding requests;
- cache lookup;
- diagnosing stale data.

The hash algorithm must be explicit and versioned.

File size and modification time may be used as fast change-detection hints, but a
content hash is stronger evidence. Modification time alone must not be treated as
proof that content is unchanged.

Metadata should record the hash algorithm when more than one algorithm may exist.

## Paths

Persistent document paths must:

- be relative to the indexing root;
- use a normalized separator convention;
- not contain `.` or unresolved `..` segments;
- remain within the indexing root;
- preserve the original filename casing.

Absolute paths may be used temporarily during processing but should not normally
be stored in portable index metadata.

Display paths and identity paths may eventually need separate representations on
case-insensitive filesystems.

## Source positions

Chunk source positions refer to the exact decoded JavaScript string produced by
the decoding subsystem. The canonical conventions are:

- `startOffset` is a zero-based UTF-16 code-unit offset and is inclusive;
- `endOffset` is a zero-based UTF-16 code-unit offset and is exclusive;
- `startLine` and `endLine` are one-based and inclusive;
- `endLine` is the line containing the code unit at `endOffset - 1`;
- a chunk must not split a Unicode surrogate pair;
- `content` must equal `document.content.slice(startOffset, endOffset)`.

Offsets intentionally follow JavaScript string indexing so implementations can
slice and validate without conversion. They are not byte offsets or Unicode code
point indexes. Original-byte identity is represented separately by a byte-content
hash.

The implemented source-position contract is:

```ts
export interface SourceRange {
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
}

export interface SourceSlice {
    range: SourceRange;
    content: string;
}
```

`SourcePositionIndex` precomputes line starts once for one decoded document. It
creates and validates plain `SourceRange` objects, returns exact source slices, and
looks up line numbers without rescanning the complete prefix for every chunk. LF,
CRLF, and lone CR line endings are recognized without changing the source string.
When a document ends with a line break, the index counts the final empty logical
line, but a non-empty range ending immediately after that break ends on the line
containing the break.

Ranges must be non-empty. Empty documents therefore have one logical line but
cannot produce a chunk range. Parser byte offsets must be translated to UTF-16
before calling this API; parser-offset translation belongs to the future parser
adapter layer.

## Provenance

Metadata produced by inference should retain its source.

For example:

```ts
export interface MetadataEvidence {
    source: "path" | "extension" | "content" | "shebang" | "parser" | "configuration";
    value: string;
    confidence?: number;
}
```

Provenance is particularly useful for:

- language classification;
- generated-file detection;
- symbol extraction;
- fallback chunking;
- encoding detection.

User-supplied metadata should be distinguishable from inferred metadata.

## Merging metadata

Metadata may be produced by several stages:

- discovery;
- classification;
- decoding;
- chunking;
- embeddings;
- the indexing coordinator.

Merge behavior must be explicit.

A stage should normally write only to the metadata fields it owns. For example:

- discovery owns path and filesystem metadata;
- classification owns language, format, encoding evidence, confidence, and traits;
- decoding owns the selected canonical encoding, canonical decoded content
  boundary, and decoding diagnostics;
- chunking owns source ranges, chunk kinds, and symbol metadata;
- embeddings own separate embedding records and model identity;
- the indexing coordinator owns index and processing-run metadata.

Conflicting values must not be silently overwritten.

## Validation

Metadata must be validated before persistent storage.

Validation should confirm that:

- required identifiers are present;
- schema versions are supported;
- paths are normalized;
- hashes use supported formats;
- source ranges are valid;
- chunk ranges fit within their source document;
- confidence values use the documented range;
- dates use a consistent representation;
- values are serializable;
- filterable fields use supported value types.

Invalid metadata should produce a structured error identifying the field and
record ID.

## Serialization

Persistent metadata should be JSON-compatible.

Allowed values should be limited to:

- strings;
- finite numbers;
- booleans;
- null;
- arrays of supported values;
- objects containing supported values.

Do not store:

- undefined;
- NaN;
- positive or negative infinity;
- functions;
- class instances;
- Date objects directly;
- typed arrays directly.

Dates should be serialized as ISO 8601 strings.

## Filterable metadata

Metadata used by retrieval filters should have a stable, storage-independent
representation.

Likely filterable fields include:

- indexing root or project;
- relative path;
- file extension;
- language;
- format;
- content kind;
- file traits;
- chunk kind;
- symbol kind;
- chunking strategy;
- embedding model identity.

Storage adapters may require flat scalar fields. The canonical metadata model may
remain structured, while a separate function creates a flat filter projection.

```ts
export type FilterValue = string | number | boolean;

export type FilterMetadata = Record<
    string,
    FilterValue | FilterValue[]
>;
```

Provider-specific field names or limitations must not leak into the canonical
metadata model.

## Extensions

Strategy-specific metadata should be namespaced rather than added freely to the
top-level schema.

For example:

```ts
export interface ChunkMetadata {
    // Common fields...
    extensions?: {
        [namespace: string]: Record<string, unknown>;
    };
}
```

Extension values must still be serializable and validated.

Important fields used across multiple strategies should be promoted into the
canonical schema instead of duplicated in extensions.

## Testing

Tests should cover:

- deterministic document and chunk identifiers;
- path normalization;
- identifier collision detection;
- content hashing;
- valid and invalid source ranges;
- serialization;
- unsupported schema versions;
- metadata merge conflicts;
- filter projection;
- missing optional fields;
- extension namespaces;
- schema migration.

## MVP contract

The first implementation includes:

- versioned document and chunk schemas;
- normalized relative paths;
- deterministic repository, snapshot, index-build, file-revision, document, chunk,
  and embedding-input identities;
- one explicit content-hash algorithm;
- canonical UTF-16 source positions;
- canonical UTF-8 and Windows-1251 encoding metadata;
- metadata validation and JSON serialization;
- stage-owned merge rules;
- a small allowlist of filterable fields.

Schema migrations, extension namespaces, case-folded identity paths, and general
user-defined metadata are later work.

## Implemented layout

- `contracts/source-position.ts` — canonical range and source-slice contracts;
- `contracts/identity.ts` — versioned identity inputs;
- `contracts/records.ts` — document, chunk, and filter metadata;
- `constants/` — schema and hashing identities;
- `hashing/` — deterministic byte and text hashing;
- `identities/` — repository, snapshot, build, revision, document, chunk, and
  embedding identity constructors;
- `paths/` — persisted relative-path normalization;
- `validation/` — record validation;
- `source-positions/line-index.ts` — reusable line-start index and binary lookup;
- `source-positions/create-range.ts` — range construction from UTF-16 offsets;
- `source-positions/validate-range.ts` — bounds, line, and surrogate validation;
- `source-positions/source-position-index.ts` — public document-scoped API;
- `errors/` — stable structured source-position errors;
- `index.ts` — the currently implemented metadata public API;
- `testing/` — LF, CRLF, Unicode, slicing, and invalid-range tests.

Merge rules, schema migration, and extension namespaces remain later metadata
increments.

## Repository versions and snapshots

Retrieval must distinguish between different versions of the same repository.
Results from another version must not be included unless cross-version retrieval
is explicitly requested.

A mutable branch or version name is not a stable snapshot identity. When Git is
available, an immutable commit hash should be used as the primary snapshot
identity. Branches, tags, and project-specific version names should be stored as
aliases that resolve to snapshots.

Metadata should distinguish between:

- repository identity;
- logical document path;
- immutable source snapshot;
- file revision identified by content;
- membership of a file revision at a path within a snapshot;
- mutable branch, tag, or project-version aliases.

Identical file revisions may be shared by multiple snapshots. Their chunks and
embeddings should be reused when their chunking and embedding inputs are also
identical.

Branch or version names should not be embedded into document content. A caller
resolves an alias to an immutable snapshot before constructing retrieval scope.

Retrieval requires a repository, source snapshot, and exact ready index build by
default. Searching across snapshots or builds must be an explicit operation.

Working-tree content that differs from its Git commit must be represented as a
separate snapshot or overlay. It must not be mislabeled as the unchanged commit.

The snapshot identity represents source state only. Changing classification,
chunking, formatting, or embedding configuration creates another `indexBuildId`
for the same `snapshotId`; it never changes the source snapshot identity.
