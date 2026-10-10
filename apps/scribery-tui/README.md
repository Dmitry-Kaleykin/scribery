# scribery-tui

Interactive terminal interface for Scribery. This is the maintained UI in the
monorepo; the abandoned web UI is not part of Scribery.

Provider profiles and indexing presets use menus to edit individual settings.
Run `/profile <name>` → **Edit profile** or `/preset <name>` → **Edit preset**,
then select the field to change. Current values appear beside each setting;
each valid change is saved immediately. Escape cancels the current edit or leaves
the menu, without reverting previously saved changes. Invalid input leaves the
stored value unchanged and returns to the menu.

Profiles expose model pickers directly, with separate **Endpoints** and
**Limits and timeouts** menus. Compression and reranking can be disabled from
their model pickers. Changing a compression or reranker setting does not inspect
the embedding model. Selecting a different embedding model detects its dimensions;
the dimensions field also supports explicit values or `auto`.

Presets expose profile, chunk size, include/exclude patterns, and encoding fallback
individually. Documentation indexing shows profile and preset choices before
starting, even when a preferred preset already exists. Manual and live indexing
also offer independent configuration choices. Creating new profiles and presets
still uses the guided setup.

Both profiles and presets also offer an advanced `Edit JSON` action. JSON editing uses `$VISUAL`, then `$EDITOR`, then
`micro`, with `nano` as the final fallback. Scribery validates the edited item
before applying it atomically; names remain managed by the separate rename
action, and profile API keys never appear in the temporary JSON file.

## Internal structure

`src/app.ts` is the composition shell: it creates shared services, connects
controllers to the terminal UI, dispatches commands, and owns application
lifecycle. Feature workflows live under `src/features`, manual-operation state
under `src/operations`, provider and persistence adapters under `src/services`,
and reusable terminal presentation under `src/ui`. Controllers depend on small
UI callback interfaces instead of the application class, so a workflow can be
extended or tested without growing the shell again.

## Live indexing

Create the project's first index with `/index`, then use `/live` (or
`/live start`) to keep the current Git worktree indexed. Live mode uses the
project's selected provider profile and preset and publishes one temporary
`live/current` target only after a complete build still matches the current
worktree. The header shows the actual branch; permanent release, stage, and
stable targets remain separately managed with manual indexing.

Useful commands:

```text
/live status
/live reconcile
/live stop
/live cleanup
```

Changes wait for 750 ms of quiet, with a maximum wait of five seconds and at
least five seconds between build starts. Git state is also polled every two
seconds. Before building, live mode compares selected file paths and content
hashes, skipping duplicate events, excluded changes, and saves reverted to
indexed content. Only one build runs at a time; changes received during it
are combined into one scheduled follow-up. `/live reconcile` skips the quiet
period and deliberately requests indexing, subject to the build interval.
While a confirmed change is pending, indexing, or failed, implicit retrieval
is paused until a matching build is ready.

Branch switches advance the same temporary target. Live builds can reuse
artifacts from other branches without retaining branch targets. The cache
keeps the newest 20 unreferenced live builds, in addition to protected builds.
Permanent targets and their history, active selections, and the selection
saved before live mode starts are protected from cache eviction.

Stopping live mode—or exiting the TUI—removes the temporary target and
restores the previous retrieval selection. An expired session is recovered
when targets or implicit retrieval are read. The watcher runs in the
foreground with the TUI; it is not a background daemon.

For projects indexed with the old per-branch live mode, run `/live cleanup`
after stopping live mode. This explicitly removes legacy `live/<branch>`
targets, retaining their builds for reuse. An active legacy target becomes
an exact build selection. Ordinary named targets are preserved.
