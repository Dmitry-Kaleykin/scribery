# MCP interface

Scribery exposes four code-focused tools over stdio. The client owns the server
process; stdout is reserved for MCP JSON-RPC, with startup failures on stderr.

```sh
scribery-mcp --project /path/to/project --profile local-qwen
# Equivalent:
scribery mcp --project /path/to/project --profile local-qwen
```

Use the absolute path printed by `command -v scribery-mcp` when the MCP host does
not inherit your interactive shell's PATH.

## Tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `search_codebase` | `query`, optional `limit`, `compress` | Search the project's active immutable index. |
| `list_targets` | None | List target names/build IDs and the shared active selection. |
| `switch_target` | `target` | Activate an existing ready target without rebuilding. |
| `index_codebase` | Optional `target` | Index the current working tree using saved settings, create or update the destination target, and activate it after success. |

All four tools are always advertised. Configure whitelists and approval in your
MCP client (for example, pi). The former `--tools` option and `retrieval` alias
have been removed; old startup configurations using `--tools` must be updated.
Project listing, stored-chunk inspection, and documentation tools are no longer
part of MCP. Agents should read actual files using their normal codebase tools.
Documentation remains available through Scribery's other interfaces.

`search_codebase` and `list_targets` are read tools. `switch_target` changes
shared project state. `index_codebase` writes index data, calls the saved
embedding provider, and applies saved retention, which may delete replaced
builds. Its MCP annotations reflect these effects.

## Project and target selection

`--project` accepts a managed project identifier, exact source root, or managed
database path. Without it, Scribery resolves the project from the server's
working directory or selects the only available project. There is no per-tool
project argument; configure the intended project at startup.

Targets are labels for immutable builds, not Git branches. None of these tools
checks out a branch. Selection is shared with the CLI, TUI, and other MCP
clients, and is read again for each search. With no stored selection, search
falls back to the latest ready build.

## Indexing workflow

Configure and index the project once through the CLI/TUI to save its indexing
recipe. MCP reuses that recipe's provider profile or inline configuration,
include/exclude rules, dirty-tree policy, encoding, chunk size, and retention.
MCP startup retrieval options do not override saved indexing settings. Named
provider profiles are resolved afresh when indexing. MCP does not overwrite the
manual indexing recipe.

After checking out a task branch, call:

```json
{"name":"index_codebase","arguments":{}}
```

The current Git branch name supplies the target. To use a different label:

```json
{"name":"index_codebase","arguments":{"target":"task/custom-label"}}
```

An explicit target is required for detached HEAD and plain directories. Target
names must satisfy Scribery's target-name validation; a branch name that does
not fit requires an explicit valid label. `live/current` is reserved.

The destination is published and activated only after a ready build exists.
Cancellation, indexing failure, or a detected branch/HEAD change prevents
publication. The response contains the active target/build, file/chunk and
embedding counts, plus a diagnostic count and log path when needed. Detailed
diagnostics remain in the existing indexing logs. Ready but unpublished builds
can remain after cancellation or a branch change.
If selection previously fell back to the latest ready build, indexing first
pins that build so an unpublished build cannot silently become active.

Clients requesting MCP progress receive throttled notifications. Indexing
honors request cancellation; configure the client's request timeout to allow
indexing to finish. Competing mutations within the server process are rejected
with a retry message. Stop TUI live indexing before indexing or switching
targets through MCP; search respects its readiness state.

## Search configuration

Semantic search sends the query to the embedding model for the selected build.
`--profile` supplies the OpenAI-compatible URL and optional reranker/compression
settings. Explicit `--base-url`, `--rerank-model`, and `--rerank-instruction` are
supported when no profile is selected. Provider options cannot be mixed with
`--profile`.

For authentication, set `OPENAI_COMPATIBLE_API_KEY` in the MCP host environment.
`LM_STUDIO_API_KEY` remains a fallback; explicit `--api-key` takes precedence.
The key is also passed to the saved indexing provider and is never persisted in
a provider profile.

Codebase search returns six candidate chunks by default. Scores are ranking
values, not confidence probabilities. Recent edits may not be indexed; an empty
result does not prove that code is absent. Search failures include the reason
and an actionable next step.

Contextual compression selects exact source passages under one shared
30-second deadline. Successful passages from one file are grouped; failed
selection retains the original candidates with diagnostics. Use
`compress: false` to return original matches. The server supports
`--compression-model`, `--compression-base-url`, `--compression-timeout`, and
`--no-compression`, or saved profile settings. See
[configuration and limits](../../../scribery-core/src/compression/README.md).

An example server definition (adapt the enclosing configuration to your host):

```json
{
  "command": "/absolute/path/to/scribery-mcp",
  "args": ["--project", "/path/to/project", "--profile", "local-qwen"],
  "env": {
    "OPENAI_COMPATIBLE_API_KEY": "your-provider-api-key"
  }
}
```
