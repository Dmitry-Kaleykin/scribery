# Migration status

## Completed in the initial baseline

- Initialized the independent Scribery monorepo.
- Split the reference implementation into `scribery-core`, `scribery-code`,
  `scribery-documents`, `scribery`, and `scribery-tui` workspaces.
- Established and automatically checks one-way package dependencies.
- Preserved code-project, documentation, CLI, MCP, and TUI behavior and tests.
- Renamed executables to `scribery`, `scribery-mcp`, and `scribery-tui`.
- Moved new runtime state to `~/.scribery` and TUI overrides to
  `SCRIBERY_TUI_HOME`.
- Gave Scribery builds their own implementation identity so they cannot be
  confused with builds from the reference application.
- Injected document-processing runtimes into `IndexBuildEngine`; code and
  document packages now independently compose their parser and chunking
  capabilities.

## Intentionally not migrated

Scribery does not read or modify `~/.blue-scribes`. The old applications and
their indexes remain an independent reference installation. A deliberate import
tool can be designed later if retaining old generated indexes becomes useful.

## Deferred features

- PDF, DOCX, and legacy DOC extraction;
- branch-aware live code indexing;
- watched directory synchronization for document libraries;
- import or migration of legacy generated state.
