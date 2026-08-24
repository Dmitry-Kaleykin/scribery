# Reusable configuration

The configuration module owns reusable local provider profiles, global indexing
presets, and OpenAI-compatible endpoint discovery. These files are user state under
`~/.scribery`; they are never written into indexed projects.

A profile contains:

- the OpenAI-compatible embedding model, dimensions, URL, optional input suffix, and
  batch size;
- an optional local Qwen3 reranking model and instruction;
- stable creation and update timestamps.

API keys are not persisted. CLI operations read `OPENAI_COMPATIBLE_API_KEY` and
fall back to the legacy `LM_STUDIO_API_KEY`; other consumers pass an API key to
`ProviderProfileService`.

## Provider profile CLI

Discover loaded models and inspect an embedding model:

```sh
scribery profile models
scribery profile inspect text-embedding-qwen3-embedding-0.6b
```

Create a profile while detecting its vector dimensions:

```sh
scribery profile set local-qwen \
  --model text-embedding-qwen3-embedding-0.6b \
  --detect-dimensions \
  --rerank-model qwen3-reranker-0.6b
```

Manage and diagnose profiles:

```sh
scribery profile list
scribery profile show local-qwen
scribery profile test local-qwen
scribery profile rename local-qwen local-embedding
scribery profile delete local-qwen
```

`profile test` exercises both the embedding model and the optional reranker.
Profile writes are atomic. Updating a profile preserves its `createdAt`
timestamp and replaces its provider configuration. Project indexing recipes
refer to a profile by name, so subsequent `reindex` operations use its current
configuration.

## Indexing presets

An indexing preset is a reusable template for the first index of one or more
projects. It contains:

- a required provider profile name;
- an optional cAST maximum chunk size;
- optional Windows-1251 fallback behavior;
- optional include and exclude glob lists.

Presets are stored atomically in
`~/.scribery/indexing-presets.json`. Create and manage them with:

```sh
scribery preset set legacy-web \
  --profile local-qwen \
  --chunk-size 3000 \
  --windows-1251 \
  --include "src/**" \
  --exclude "vendor/**"

scribery preset list
scribery preset show legacy-web
scribery preset rename legacy-web web
scribery preset delete legacy-web
```

Use a preset for a first managed index:

```sh
scribery index . --preset legacy-web --target release128
```

The effective values are copied into the project's concrete indexing recipe
after the build succeeds. The recipe keeps the provider profile reference but
does not keep a preset reference. Editing a preset therefore affects future
first indexes only, not existing projects or their later `reindex` operations.

Explicit `index` arguments take precedence over preset values. `--profile`
overrides the preset provider. `--chunk-size`, repeated `--include` or
`--exclude`, and `--windows-1251` or `--no-windows-1251` override their
corresponding preset values. Inline embedding provider arguments cannot be
combined with a preset.

## UI integration

The package root exports:

- `ProviderProfileService`;
- `ProviderProfileCatalog`;
- `IndexingPresetService`;
- `IndexingPresetCatalog`;
- `OpenAiCompatibleDiscoveryService`;
- all persisted profile, preset, and discovery result contracts.

The discovery service lists `/v1/models` and measures the actual vector returned
by an embedding model. A UI can therefore present model selection and dimensions
without duplicating OpenAI-compatible protocol logic.
