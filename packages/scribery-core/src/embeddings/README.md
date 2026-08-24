# Embeddings

This directory contains the logic used to convert document chunks and search
queries into embedding vectors.

The rest of the application should interact with a provider-independent interface.
Local models, hosted APIs, and test implementations should be interchangeable
without changing the indexing pipeline.

## Responsibilities

The embeddings subsystem is responsible for:

- converting document chunks into embedding vectors;
- converting search queries into embedding vectors;
- preparing provider-specific embedding input;
- batching embedding requests;
- enforcing model input limits;
- validating returned vectors;
- reporting model and vector metadata;
- handling provider-specific retries and rate limits;
- supporting cancellation;
- optionally caching embedding results.

## Non-responsibilities

The embeddings subsystem does not:

- discover or read files;
- classify documents;
- split documents into chunks;
- decide which chunks should be indexed;
- store vectors permanently;
- perform vector similarity searches;
- filter or rerank search results;
- expose retrieval through MCP.

Permanent vector storage belongs to the storage subsystem.

## Documents and queries

Document embeddings and query embeddings must be separate operations.

Some models use different prefixes, instructions, or modes for documents and
queries. Treating them as identical would make those models difficult to support.

```ts
export interface EmbeddingProvider {
    embedDocuments(
        inputs: EmbeddingDocument[],
        options?: EmbeddingRequestOptions,
    ): Promise<DocumentEmbeddingBatchResult>;

    embedQuery(
        input: EmbeddingQuery,
        options?: EmbeddingRequestOptions,
    ): Promise<QueryEmbeddingResult>;

    describe(): EmbeddingModelInfo;
}
```

## Inputs

A document embedding input should contain the text to embed and an identifier used
to associate the result with its source chunk.

```ts
export interface EmbeddingDocument {
    id: string;
    content: string;
    context?: EmbeddingContext;
}

export interface EmbeddingQuery {
    content: string;
}
```

Optional context may contain information such as:

- file path;
- programming language;
- symbol name;
- symbol kind;
- parent symbols;
- chunk kind.

Whether context is included in the text sent to the model must be controlled by a
document formatter. Metadata should not be added to embedding input accidentally.

## Input formatting

The exact text embedded for a chunk is part of the retrieval design and must be
deterministic.

For example, a code chunk might be formatted as:

```
File: src/auth/session.ts
Language: TypeScript
Symbol: createSession

<original chunk content>
```

This contextual header can improve retrieval, but it also consumes the model's
input limit and changes the resulting vector.

## Results

Document and query results use different types so input association cannot be
accidentally omitted from a document batch:

```ts
export interface DocumentEmbeddingResult {
    id: string;
    vector: Float32Array;
    model: EmbeddingModelIdentity;
    tokenCount?: number;
}

export interface QueryEmbeddingResult {
    vector: Float32Array;
    model: EmbeddingModelIdentity;
    tokenCount?: number;
}

export interface DocumentEmbeddingBatchResult {
    embeddings: DocumentEmbeddingResult[];
    usage?: EmbeddingUsage;
}
```

Results should be associated by identifier rather than relying only on array
position.

## Model identity

Every stored vector must be associated with the configuration that produced it.

```ts
export interface EmbeddingModelIdentity {
    provider: string;
    model: string;
    dimensions: number;
    metric: "cosine" | "dot-product" | "euclidean";
    revision?: string;
    documentPrefix?: string;
    queryPrefix?: string;
    embeddingSuffix?: string;
}
```

Model identity may also need to include:

- distance metric;
- normalization behavior;
- quantization;
- provider-specific task mode;
- model revision or checksum;
- document and query prefixes;
- a shared document and query suffix.

Changing any setting that affects vector compatibility should create a new model
identity and require re-embedding existing chunks.

Vectors produced by incompatible model identities must not be searched together.

## Vector validation

Every returned vector must be validated before it reaches storage.

Validation should confirm that:

- the vector has the expected number of dimensions;
- every value is a finite number;
- the result corresponds to a requested input;
- no requested input is silently missing;
- duplicate result identifiers are rejected;
- normalization matches the model's documented behavior, when required.

The subsystem must not silently truncate or pad vectors with incorrect dimensions.

## Batching

Document embeddings should be generated in configurable batches.

Batching must consider:

- the provider's maximum number of inputs;
- the model's token or character limit;
- the total request size;
- memory usage;
- rate limits;
- cancellation.

A batch should not be formed using only the number of chunks. Ten very large chunks
may exceed a provider limit even when the nominal batch size is valid.

The initial implementation may use character-based estimates. Token-aware batching
can be added when a tokenizer is available.

## Oversized inputs

Input limits must be handled explicitly.

An oversized chunk should not be silently truncated because doing so would make
the stored vector inconsistent with the stored content.

Possible policies include:

- return an error;
- ask the chunking stage to rechunk the content;
- use an explicitly configured truncation strategy.

The default should be to report the problem rather than truncate silently.

## Local and remote providers

Providers may run:

- in the current Node process;
- in a local model server;
- in a separate local process;
- through a hosted API.

The provider interface should not expose transport details to the indexing
pipeline.

Remote providers must receive only the content required for embedding. Paths,
repository names, and other metadata should be sent only when explicitly included
by the formatter.

## Errors

Embedding errors should distinguish between:

- invalid input;
- input exceeding the model limit;
- unavailable provider;
- authentication failure;
- rate limiting;
- timeout;
- invalid provider response;
- incompatible vector dimensions;
- cancellation;
- internal provider failure.

Errors should identify the affected input IDs without including full document
contents.

## Retries

Only transient failures should be retried automatically.

Examples include:

- rate limiting;
- temporary provider unavailability;
- connection reset;
- timeout, when retrying is safe.

Invalid input, authentication failures, and dimension mismatches should not be
retried automatically.

Retry behavior should use bounded exponential backoff with jitter and respect
provider retry hints when available.

## Partial failures

Batch behavior must be explicit when only some inputs fail.

A batch must not silently return fewer embeddings than requested.

The provider may either:

- fail the entire batch; or
- return a structured result containing successes and failures.

Whichever approach is chosen must preserve the ID of every input.

## Caching

Embedding results may be cached using a key derived from:

- the exact formatted input;
- model identity;
- formatter version;
- relevant provider options.

A content hash alone is insufficient if the model or formatting configuration can
change.

Caching must be optional and independent from permanent vector storage.

## Security and privacy

Embedding input may contain private source code and sensitive text.

The subsystem must:

- avoid logging complete embedding input by default;
- avoid including content in error messages;
- obtain credentials from configuration or environment variables;
- never store credentials in source files or metadata;
- make remote transmission explicit in configuration;
- support fully local providers.

Diagnostics may include input IDs, sizes, hashes, model names, and timing data.

## Cancellation

Embedding requests should accept an AbortSignal.

## Observability

The subsystem may report:

- number of embedded inputs;
- number of batches;
- cache hits and misses;
- input size or token estimates;
- request duration;
- retry count;
- provider and model identity.

Observability must not expose document contents by default.

## Invariants

Every embedding provider must guarantee that:

- every successful input has exactly one result;
- results can be associated with their input IDs;
- all vectors have the declared number of dimensions;
- all vector values are finite;
- the model identity accurately describes vector compatibility;
- document and query modes are not accidentally interchanged;
- oversized input is not silently truncated;
- credentials and complete input contents are not logged;
- cancellation does not start additional batches;
- provider-specific behavior does not leak into the indexing pipeline.

## Testing

Provider-independent tests should cover:

- empty input batches;
- one and multiple documents;
- preserved input-to-result association;
- invalid dimensions;
- non-finite vector values;
- missing and duplicate results;
- oversized inputs;
- cancellation;
- transient and permanent errors;
- retry limits;
- document and query formatting;
- cache invalidation after model or formatter changes.

Tests should use a deterministic fake provider rather than requiring a real model
or network connection.

## MVP contract

The first implementation includes:

- a one-input provider diagnostic before CLI indexing begins;
- deterministic document and query formatting;
- a deterministic fake provider and one real provider;
- separate document and query operations;
- identifier-based batch association;
- character-aware bounded batches;
- incremental async batch consumption;
- structured per-batch progress;
- strict input-limit and vector validation;
- one explicit model identity per build;
- cancellation;
- whole-batch failure with structured affected IDs.

Retries, caching, token-aware batching, partial batch success, quantization, and
multiple simultaneous model identities are later work.

## Implemented layout

- `contracts/` — provider, input, output, and model-identity contracts;
- `embedding-service.ts` — formatting-independent batching and validation;
- `diagnostics/` — a representative provider request with strict result validation;
- `formatting/` — deterministic document and query input construction;
- OpenAI-compatible provider implementation — embeddings requests that
  requests embeddings, preserves bounded provider errors, and validates the
  configured output dimensions;
- `providers/fake/` — deterministic test provider;
- `errors/` and `constants/` — structured failures and bounded defaults.

---

The most important rule is that the **embedding model identity travels with every
vector**. Otherwise, changing from one model to another—or even changing dimensions
or document prefixes—could leave incompatible vectors mixed in the same index.

It is also worth keeping these two values separate:

```ts
chunk.content          // Exact source text, stored and shown to users
embeddingInput         // Possibly enriched text sent to the model
```
