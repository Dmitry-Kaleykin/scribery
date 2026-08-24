# Reranking

This subsystem assigns query-specific relevance scores to a bounded set of
retrieval candidates. It is independent of candidate generation and storage, so a
reranker cannot introduce content from another repository, snapshot, or index
build.

## Pipeline position

```text
filtered vector candidates
        → local reranking
        → final result selection
        → optional context expansion
```

Only cAST chunks that already passed storage scope and metadata filters are sent to
the provider. The retrieval subsystem validates that the provider returns exactly
one finite score for every candidate and preserves semantic rank as the
deterministic tie-breaker.

## Provider contract

`RerankingProvider` receives a query and candidate IDs with formatted content. A
provider declares per-request candidate and character limits. `RerankingService`
splits work into sequential bounded batches, validates identities and scores, and
restores input ordering across provider batches.

The provider boundary allows future local cross-encoders or hosted APIs without
coupling retrieval to their HTTP formats.

## Dedicated OpenAI-compatible rerank endpoint

`OpenAiCompatibleRerankProvider` sends each bounded candidate batch to
`POST /v1/rerank` using the Cohere/Jina-style `query`, `documents`, `top_n`, and
`return_documents` request fields. It maps the returned `index` and
`relevance_score` values back to candidate identities and validates that every
candidate received exactly one finite score. This is the preferred interface for
oMLX and other runtimes with a native reranker endpoint.

## Legacy OpenAI-compatible Qwen3 completions

`OpenAiCompatibleQwen3RerankingProvider` supports Qwen3-Reranker models served
through an OpenAI-compatible legacy `/v1/completions` endpoint. It does not rely
on a dedicated reranking endpoint or automatic chat-template formatting.

Each query-document pair is formatted with Qwen3-Reranker's documented prompt. The
provider applies the same bias to Qwen3's `yes` and `no` token identifiers so they
are the only competitive next-token labels, requests their log-probabilities, then
normalizes them into a score between zero and one. The equal bias preserves their
relative logit difference. Candidate text is escaped so source code containing
Qwen special-token text cannot terminate the prompt fields.

The provider sends one request per candidate with at most four in flight by
default, avoiding runtime-specific prompt-array behavior. This concurrency limit
is independent of the logical candidate batch and can be changed through
`maximumConcurrentRequests`. When a constrained completion
contains exactly `yes` or `no`, the provider therefore uses deterministic scores
of one or zero. Retrieval uses the original semantic score as the tie-breaker
within each label group. A server that does expose both log-probabilities
automatically receives continuous scoring.

Without either probabilities or a label, a runtime response cannot be scored.

The default instruction is tailored to source-code retrieval. Callers may override
it for another retrieval domain.

## Failure behavior

Reranking is opt-in and strict by default. Provider errors, incomplete score sets,
and responses without both `yes` and `no` log-probabilities fail retrieval with
`reranking-failed`.

Callers may explicitly select `failureMode: "use-semantic-order"`. In that mode,
provider failures return the original semantic order, still truncated to the final
result limit. Cancellation never falls back.

## Layout

- `contracts/` — provider identity, candidate, request, and score types;
- `constants/` — provider limits and the default code-retrieval instruction;
- `formatting/` — Qwen3 prompt construction and source-text escaping;
- provider implementations — native batch reranking and Qwen3 next-token scoring;
- `reranking-service.ts` — batching and provider-response validation;
- `errors/` — structured local reranking failures;
- `testing/` — HTTP-shape, scoring, batching, and validation tests.
