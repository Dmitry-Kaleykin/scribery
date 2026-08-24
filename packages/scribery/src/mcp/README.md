# MCP interface

The MCP interface exposes Scribery' existing catalogs, immutable index
builds, and semantic retrieval pipeline to local MCP clients. It uses the stdio
transport: the client owns the server process and exchanges MCP JSON-RPC messages
over its stdin and stdout.

Run it directly with either executable:

```sh
scribery-mcp --project /path/to/project
scribery mcp --project /path/to/project
```

`scribery-mcp` is preferred in host configuration because it cannot accidentally
enter another CLI command. The server never writes banners, progress, or logs to
stdout. Startup failures are written to stderr.

## Read-only boundary

The first MCP surface intentionally contains only:

- `list_projects`;
- `search_codebase`;
- `inspect_project_chunks`;
- `list_collections`;
- `list_collection_sources`;
- `search_collection`.

Every tool is advertised as read-only, non-destructive, and idempotent. Project
and collection databases are opened in SQLite read-only immutable mode. The
server exposes no index, create, add, tag, delete, or rebuild operation.

Use `--tools` as a strict allowlist when an MCP client should see only part of
this surface:

```sh
scribery-mcp --project /path/to/project --tools search_codebase
scribery-mcp --tools search_codebase,inspect_project_chunks
```

The former allowlist name `retrieval` remains a compatibility alias for
`search_codebase`, but clients see and call only `search_codebase`.

The option accepts comma-separated names and may be repeated. Unknown or empty
names stop startup with an error. Excluded tools are not registered and therefore
do not appear in MCP `tools/list`; this is distinct from Cline's `autoApprove`,
which controls confirmation but does not define the server's tool surface.

Semantic searches still send the query to the embedding model selected by the
stored build. `--profile` supplies the OpenAI-compatible URL and optional reranker from a
global provider profile. Explicit `--base-url`, `--rerank-model`, and
`--rerank-instruction` remain supported when no profile is selected. Provider
options cannot be mixed with `--profile`.

For an authenticated provider, set `OPENAI_COMPATIBLE_API_KEY` in the MCP host's
server environment. The server sends it as a Bearer token to both the embedding
and reranking endpoints. The legacy `LM_STUDIO_API_KEY` variable remains a
fallback. An explicit `--api-key <key>` argument is also supported and takes
precedence over both environment variables; API keys are never persisted in a
provider profile.

## Scope selection

`--project` accepts a managed project identifier, its exact source root, or its
managed database path. `--collection` accepts a collection name or identifier.
Collection calls can override their default. `search_codebase` deliberately has
no project or build selector: configure `--project` when starting the server. If
no project is configured, the server selects the only available project.

Project search uses the project's active selection—a named target or a directly
selected build—and re-reads that selection for every request. A CLI
`scribery retrieval switch` therefore takes effect without restarting MCP. With no
stored selection it falls back to the latest ready build for backward
compatibility. File-chunk inspection can request another ready build. Search and
chunk-inspection attribution includes the resolved selection and build identifier.

Context expansion is enabled automatically for codebase search and uses one chunk
before, one after, and up to 4,000 neighboring characters for each result. The
tool returns 10 ranked excerpts by default and accepts only a query plus an
optional result limit. File-chunk inspection is paginated and returns at most 100
chunks per call.

## Cline configuration

Use the absolute path printed by `command -v scribery-mcp`, particularly when
Cline runs inside a JetBrains GUI process managed outside an interactive shell:

```json
{
  "mcpServers": {
    "scribery": {
      "type": "stdio",
      "command": "/absolute/path/to/scribery-mcp",
      "args": [
        "--project",
        "/path/to/project",
        "--rerank-model",
        "qwen3-reranker-0.6b",
        "--tools",
        "search_codebase"
      ],
      "env": {
        "OPENAI_COMPATIBLE_API_KEY": "your-provider-api-key"
      },
      "disabled": false,
      "timeout": 120,
      "autoApprove": [
        "search_codebase"
      ]
    }
  }
}
```

The configured provider and the build's embedding model must be running when a search tool is
called. Listing and stored-chunk inspection do not require an embedding model.
