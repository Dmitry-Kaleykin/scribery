# Retrieval

This directory contains the logic used to find indexed chunks relevant to a query.

Retrieval coordinates query embedding, metadata filtering, candidate generation,
optional lexical search, candidate fusion, reranking, and result construction.

## Core design decisions

- Retrieval is scoped to an exact repository, source snapshot, and ready index
  build by default.
- Cross-version retrieval must be explicitly requested.
- Snapshot, index-build, and permission filters are hard constraints, not ranking
  preferences.
- Query and document embeddings may use different model modes.
- Retrieved content must retain precise source attribution.
- Reranking operates only on candidates that already satisfy hard filters.
- Provider-specific query syntax must not leak into the public retrieval interface.
- Retrieval scores are diagnostic values, not universal measures of relevance.

## Responsibilities

The retrieval subsystem is responsible for:

- validating retrieval requests;
- resolving and enforcing retrieval scope;
- validating metadata filters;
- embedding semantic search queries;
- requesting candidates from storage backends;
- optionally performing lexical or exact-text search;
- combining candidates from multiple retrieval methods;
- removing duplicate results;
- reranking candidates;
- applying result diversity rules;
- optionally expanding results with neighboring context;
- enforcing result and context limits;
- returning source-attributed results;
- reporting retrieval diagnostics.

## Non-responsibilities

The retrieval subsystem does not:

- discover or index files;
- classify or chunk documents;
- generate document embeddings;
- mutate source-control state;
- define source-control snapshots;
- store vectors or metadata permanently;
- build the final LLM prompt;
- answer the user's question;
- expose MCP tools directly.

The MCP layer or application layer may convert retrieval results into an LLM-facing
response or context block.

## Retrieval pipeline

The retrieval pipeline is conceptually:

```text
request
  → validate repository, snapshot, build, and filters
  → resolve snapshot membership
  → embed query
  → generate semantic and lexical candidates
  → enforce hard filters
  → normalize and fuse candidates
  → deduplicate
  → rerank
  → diversify
  → optionally expand context
  → enforce limits
  → return attributed results
```

Implementations may optimize this sequence, but hard filters must be enforced before
results are returned.

## Retrieval request

A retrieval request should contain:

```ts
export interface RetrievalRequest {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
    query: string;
    filters?: StorageFilterCondition[];
    limit?: number;
    rerank?: RetrievalRerankingOptions;
    context?: RetrievalContextOptions;
    signal?: AbortSignal;
}
```

Lexical and hybrid modes may extend this request later.

Empty or whitespace-only queries should be rejected unless a specific retrieval
mode supports them.

## Retrieval scope

Retrieval must require an explicit scope:

```ts
export interface RetrievalScope {
    repositoryId: string;
    snapshotId: string;
    indexBuildId: string;
}
```

The scope may later include:

- indexing root;
- workspace;
- collection;
- tenant;
- access-control context.

The current branch name is not sufficient as a retrieval scope because branches
are mutable. A branch or project-version alias must first resolve to an immutable
snapshot.

The build identifies the exact classification, chunking, formatting, and embedding
configuration used for search. It must belong to the requested repository and
snapshot and have `status: "ready"`.

If the requested snapshot or build is unknown, incompatible, or incomplete,
retrieval returns a descriptive error rather than selecting another indexed
version automatically.

## Query embeddings

Retrieval uses the embedding provider's query mode:

```ts
embeddingProvider.embedQuery(...)
```

It must not use the document embedding mode accidentally.

The query embedding model identity must be compatible with the document vectors
being searched. Retrieval should reject incompatible dimensions, model identities,
or task modes.

If several embedding indexes exist, model selection must be explicit and
deterministic.

## Filters

Filters represent hard eligibility requirements.

Possible filters include:

- relative path;
- path prefix;
- file extension;
- language;
- format;
- file traits;
- chunk kind;
- symbol name;
- symbol kind;
- indexing root;
- embedding model identity.

Repository, snapshot, and index-build restrictions belong to retrieval scope rather
than ordinary optional filters.

## Filter representation

The public filter language must be independent of any storage provider.

A possible filter model is:

```ts
export type RetrievalFilter =
    | {
        operator: "and";
        filters: RetrievalFilter[];
    }
    | {
        operator: "or";
        filters: RetrievalFilter[];
    }
    | {
        operator: "not";
        filter: RetrievalFilter;
    }
    | {
        operator: "equals";
        field: FilterableField;
        value: FilterValue;
    }
    | {
        operator: "in";
        field: FilterableField;
        values: FilterValue[];
    }
    | {
        operator: "prefix";
        field: FilterableField;
        value: string;
    };
```

The initial implementation may support only `and`, `equals`, and `in`.

Filter fields must come from an allowlist. Arbitrary storage field names, SQL,
regular expressions, or backend query fragments must not be accepted from callers.

## Filter execution

Hard filters should be applied by the storage backend whenever possible.

Post-filtering a small vector result set can produce too few results or no results
even when relevant matching chunks exist. If a backend cannot apply a required
filter during candidate search, retrieval must compensate by over-fetching,
iterating, or using a precomputed candidate set.

Regardless of backend behavior, retrieval must verify hard constraints before
returning results.

Snapshot and index-build membership must always be verified.

## Candidate generation

Candidate generation should request more results than the final result limit:

```ts
candidateLimit > resultLimit
```

This provides enough candidates for:

- filtering;
- deduplication;
- reranking;
- diversity;
- context expansion.

Defaults should be configurable and bounded.

A request for 10 final results might initially retrieve 50 candidates, but the
correct ratio should be determined through evaluation.

## Candidate representation

```ts
export interface RetrievalCandidate {
    chunkId: string;
    documentId: string;
    fileRevisionId: string;
    snapshotId: string;
    indexBuildId: string;

    path: string;
    content: string;
    metadata: ChunkMetadata;

    semanticScore?: number;
    lexicalScore?: number;
    fusedScore?: number;
    rerankScore?: number;
}
```

A candidate must contain enough identity information to verify snapshot membership
and index-build membership and reconstruct the final source attribution.

## Score handling

Scores from different providers or retrieval methods may use different scales and
directions.

Retrieval must document whether a score represents:

- similarity, where higher is better;
- distance, where lower is better;
- normalized relevance;
- backend-specific ranking.

Raw scores from different methods must not be added together without normalization
or a rank-based fusion method.

Reciprocal rank fusion is a reasonable initial method for hybrid retrieval because
it combines result rankings without assuming comparable score scales.

## Deduplication

Deduplication must distinguish between:

- the same chunk returned by multiple retrieval methods;
- identical content appearing at several paths;
- identical content belonging to several snapshots;
- identical content belonging to several index builds;
- overlapping chunks from the same document.

Candidates from semantic and lexical search that share the same chunk membership
should be fused into one candidate.

Identical content at different source locations should not always be collapsed.
Those locations may have different meaning or ownership.

Any deduplication rule must preserve all relevant source attributions.

## Reranking

Reranking receives a query and a bounded list of eligible candidates:

```ts
export interface Reranker {
    rerank(
        query: string,
        candidates: RetrievalCandidate[],
        options?: RerankOptions,
    ): Promise<RetrievalCandidate[]>;
}
```

A reranker may be:

- a local cross-encoder;
- a hosted reranking API;
- an LLM-based scorer;
- a deterministic heuristic;
- a no-op implementation.

The current implementation accepts an optional `RerankingProvider` when
constructing `SemanticRetriever`. A request enables it with:

```ts
rerank: {
    candidateLimit?: number;
    failureMode?: "error" | "use-semantic-order";
}
```

The candidate limit defaults to five times the final result limit, capped at 100,
and may not be smaller than the final limit. Storage over-fetches only this bounded
set after applying exact build scope and hard metadata filters. Reranking selects
the final result set before context expansion. A reranked result exposes its
original `semanticScore`, provider `rerankScore`, and uses the rerank score as
its final `score`.

Reranking must not introduce new candidates or remove hard scope information.

Reranking failures are strict by default. Semantic-order fallback occurs only when
the request explicitly selects `failureMode: "use-semantic-order"`; cancellation
never falls back. Reranker identity and configuration may later be included in
retrieval diagnostics.

## Diversity

Without diversity handling, retrieval may return many nearly identical chunks from
one large file.

Optional diversity rules may limit:

- results per document;
- results per symbol;
- highly overlapping source ranges;
- nearly identical content hashes.

Diversity should be applied after relevance ranking and before final result
construction.

Hard-coded diversity rules should be avoided until retrieval quality can be
evaluated.

## Context expansion

A highly relevant chunk may require adjacent context, such as:

- imports;
- a containing class;
- a neighboring type definition;
- preceding documentation;
- the next part of a large function.

Context expansion may retrieve:

- neighboring chunks;
- parent-symbol chunks;
- related declaration chunks.

The current implementation supports neighboring cAST chunks. Callers opt in with:

```ts
context: {
    beforeChunks?: number;       // default: 1
    afterChunks?: number;        // default: 1
    maximumCharacters?: number; // default: 4,000 per result
}
```

The primary match is not merged or rewritten. Each returned match instead receives
`context.before` and `context.after`, whose entries retain their chunk ID, source
index, content, range, optional cAST kind, and available semantic sidecar. Chunks that are already primary
matches in the same response are omitted from context. The character budget admits
only complete chunks, starting with the nearest preceding and following chunks.
Fetching parent declarations as additional source chunks and related-declaration
expansion remain future strategies. JavaScript and TypeScript primary matches
already retain their enclosing symbol chain and signatures as metadata; this is
included in reranking input and result formatting without duplicating source.

Expanded context must:

- belong to the same requested snapshot;
- belong to the same requested index build;
- identify why it was included;
- retain its own source attribution;
- not be presented as an independently matched result;
- respect the overall context budget.

Context expansion should not silently cross document or version boundaries.

## Retrieval result

```ts
export interface RetrievalResult {
    query: string;
    scope: RetrievalScope;
    matches: RetrievalMatch[];
    diagnostics: RetrievalDiagnostics;
}

export interface RetrievalMatch {
    chunkId: string;
    documentId: string;
    snapshotId: string;
    indexBuildId: string;
    fileRevisionId: string;

    path: string;
    content: string;

    startLine: number;
    endLine: number;
    symbol?: SymbolMetadata;

    scores: RetrievalScores;
    matchedBy: RetrievalMethod[];
    expandedContext?: ExpandedContext[];
}
```

Every match must identify its source path and range.

A retrieval result should never require the caller to infer which version or file
produced the content.

## Limits and budgets

Retrieval should enforce configurable limits for:

- query length;
- filter complexity;
- semantic candidates;
- lexical candidates;
- reranker candidates;
- final results;
- results per document;
- expanded chunks;
- total returned characters or estimated tokens;
- execution time.

The final LLM prompt budget belongs to the caller, but retrieval should support a
bounded output size.

When a budget is exceeded, results should be truncated by rank while preserving
complete attribution.

## Cancellation

All long-running retrieval operations should accept an AbortSignal.

Cancellation should:

- stop query embedding when supported;
- stop backend searches;
- prevent reranking from starting;
- cancel an active reranker request when supported;
- avoid returning a partial result as though it were complete.

## Errors

Retrieval errors should distinguish between:

- invalid query;
- invalid filter;
- unknown repository;
- unknown snapshot;
- unknown, incomplete, or mismatched index build;
- incompatible embedding model;
- unavailable embedding provider;
- unavailable storage backend;
- retrieval timeout;
- reranker failure;
- cancellation;
- corrupt or missing chunk metadata.

Errors should not include full indexed content by default.

## Testing

Tests should cover:

- exact snapshot isolation;
- exact index-build isolation;
- attempts to retrieve without a snapshot or build;
- unknown snapshots and non-ready builds;
- branch aliases moving between commits;
- dirty working-tree snapshots;
- cross-version retrieval;
- semantic retrieval;
- lexical retrieval;
- hybrid candidate fusion;
- invalid and nested filters;
- provider-side and post-filter behavior;
- incompatible embedding models;
- duplicate candidates;
- overlapping chunks;
- reranker success and failure;
- result diversity;
- context expansion;
- cancellation and timeouts;
- empty and extremely long queries;
- deterministic ordering for tied scores.

Version-isolation tests should deliberately place highly relevant content in the
wrong snapshot and the wrong index build and verify that neither is returned.

## MVP contract

The first implementation includes:

- explicit repository, snapshot, and ready-build scope;
- semantic retrieval over cAST code chunks, plus sliding-window text chunks in
  managed collections;
- semantic query embedding using the build's compatible query mode;
- storage-side snapshot and build filtering;
- a small allowlist of `and`, `equals`, and `in` filters;
- bounded candidate and result limits;
- deterministic result ordering and deduplication;
- exact path, range, and identity attribution;
- optional, count- and character-bounded neighboring cAST context;
- JavaScript and TypeScript parent-symbol metadata in vector input, reranking,
  filters, and attributed results;
- cancellation and structured diagnostics;
- optional local Qwen3 reranking through a provider-independent boundary.

Managed collections resolve their active exact build on behalf of callers and
add hard `sourceId` and tag scopes. These filters are applied before ranking; an
explicitly empty collection scope returns no results.

Plain-text document retrieval, lexical search, hybrid fusion, hosted reranking,
diversity rules, parent-declaration source expansion, cross-snapshot search, and
permission-policy integration are later work.

## Implemented layout

- `contracts/` — explicitly scoped query and attributed-result contracts;
- `constants/` — retrieval and context limits;
- `context/` — neighboring-chunk selection and budget enforcement;
- `reranking/` — retrieval-candidate formatting for the provider boundary;
- `semantic-retriever.ts` — ready-build validation, query embedding, filtered
  vector search, reranking, context expansion, and exact attribution;
- `errors/` — structured scope and query failures.

Lexical fusion, additional reranking providers, and context strategies can be
added without weakening the explicit snapshot and build scope.
