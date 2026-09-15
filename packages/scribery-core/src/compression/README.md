# Contextual compression

Compression runs after reranking (or directly after semantic retrieval when
reranking is disabled). It is enabled by default. Each distinct matched document
is inspected once, using the complete source stored in the selected index build.
No working-tree reads or reindexing are needed. It does not perform cross-file
follow-up searches.

An instruction-following model selects inclusive source line ranges. The service
validates those ranges and extracts exact source text, including original line
endings. Disjoint selections retain separate ranges; overlapping selections are
merged. Excerpts carry document, file revision, path, and source offsets. They do
not inherit the original chunk's score or identity.

## Configuration

The provider uses an OpenAI-compatible `/chat/completions` endpoint. The default
model ID is `Qwen3.5-2B`; set the exact ID served by your MLX or LM Studio server,
including a quantization suffix if needed. Qwen3.5-4B uses the same interface.
Thinking is disabled with `chat_template_kwargs.enable_thinking: false`, and a
JSON schema constrains the response. The server must support these features.
There is no retry with unconstrained text if the server rejects the schema.
Scribery does not download models or manage their residency.

A provider profile can contain:

```json
{
  "compression": {
    "enabled": true,
    "model": "Qwen3.5-2B",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "timeoutMs": 30000,
    "maximumFiles": 5,
    "maximumInputTokens": 16384,
    "maximumOutputTokens": 256,
    "maximumExcerptCharacters": 12000
  }
}
```

Omitted fields use the values above. An omitted compression endpoint inherits the
embedding endpoint; without either it uses `http://127.0.0.1:1234/v1`. The profile
API key is shared. A missing compression section enables the default model;
`enabled: false` explicitly disables it.

Configure only compression without replacing embedding or reranker settings:

```sh
scribery profile compression local-qwen --compression-model 'your-served-model-id'
scribery profile compression local-qwen --compression-base-url http://127.0.0.1:8000/v1
scribery profile compression local-qwen --no-compression
scribery profile compression local-qwen --compression
```

`profile set`, `search`, and the MCP server accept the same flags:

- `--compression-model`, `--compression-base-url`
- `--compression-timeout` (milliseconds, maximum 30000)
- `--compression-files`
- `--compression-input-tokens`, `--compression-output-tokens`
- `--compression-characters` (extracted characters per file)
- `--compression` / `--no-compression`

Explicit flags override saved compression settings. Other saved settings remain
unchanged. The TUI profile editor offers a compression model picker and a disable
option; its JSON editor supports all budgets and a separate endpoint.

```sh
scribery search 'where are retries configured?' --profile local-qwen
scribery search 'where are retries configured?' --profile local-qwen --no-compression
scribery search 'connection defaults' --documentation manual --profile local-qwen
scribery mcp --profile local-qwen --compression-model 'your-served-model-id'
```

MCP `search_codebase` and `search_documentation` accept `compress: false` or
`compress: true` to override the server's saved setting for one search. The old
`includeContext` documentation-search parameter is an alias. Old neighbor-count
options and library `context` requests produce a migration error.

## Budgets and failure behavior

The 30-second default is one deadline for the entire added compression phase,
including source reads and queueing. Files are processed serially; concurrent
searches in the same process share one extraction slot. Separate Scribery
processes do not share this queue. Cancellation aborts the HTTP request; actual
server-side compute cancellation depends on the inference server.

`maximumInputTokens` uses UTF-8 bytes as a conservative upper bound for Qwen's
byte-token input, with an additional template/schema reserve. This is intentionally
more restrictive than an exact token count, and also bounds line-number and query
text overhead. It is a per-file prompt budget; `maximumFiles` bounds total work.
`maximumOutputTokens` bounds generated selection JSON. It does not bound the
amount of selected source; `maximumExcerptCharacters` handles that separately.

Files that fit are supplied whole. Oversized files use complete indexed source
ranges, prioritizing matched chunks and then nearby chunks. Omitted sections are
marked. The model cannot select lines it did not receive or span an omitted gap.
If no complete range fits, the original matches are returned.

Timeouts, invalid selections, oversized excerpts, unavailable sources, and provider
errors return the original matches for the affected file with an explicit
fallback diagnostic. Successful extractions from earlier files are preserved.
A valid empty selection removes that file from results and reports `empty`;
it is not treated as a failure. Caller cancellation propagates as cancellation.

## Library and output contracts

```ts
const provider = new OpenAiCompatibleCompressionProvider({
    model: "your-served-model-id",
    baseUrl: "http://127.0.0.1:1234/v1",
});
const retriever = new SemanticRetriever(storage, embeddings, reranker, provider);
const results = await retriever.retrieve({
    repositoryId, snapshotId, indexBuildId, query,
    compression: { enabled: true },
    onDiagnostics: (diagnostics) => console.log(diagnostics),
});
```

Raw `SemanticRetriever` / `DocumentationService` callers must inject a compression
provider or explicitly disable compression. This keeps network construction out
of the core retrieval orchestrator. Application entry points construct the
configured provider automatically.

Raw retrieval preserves original chunk matches and scores and attaches
`compression.excerpts` and `compression.diagnostic`. `presentRetrievalResults`
produces transport results: one entry per successfully compressed file with
`excerpts` and `matchedChunks` score/range metadata; fallback entries retain their
original content. It never includes the original chunk content alongside successful
excerpts. CLI search now returns `{ results, diagnostics }` instead of an array.
MCP includes diagnostics and distinguishes returned entries from matched chunks.

Diagnostics separately measure retrieval, reranking, and compression time and
record per-file selected/empty/fallback status, failure reason, and whether input
was restricted to sections. No hardware latency or quality benchmark is implied
by the automated tests, which use deterministic model responses.
