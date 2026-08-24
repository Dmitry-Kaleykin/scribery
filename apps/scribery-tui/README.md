# scribery-tui

Interactive terminal interface for Scribery. This is the maintained UI in the
monorepo; the abandoned web UI is not part of Scribery.

Provider profiles and indexing presets offer both guided editing and an
advanced `Edit JSON` action. JSON editing uses `$VISUAL`, then `$EDITOR`, then
`micro`, with `nano` as the final fallback. Scribery validates the edited item
before applying it atomically; names remain managed by the separate rename
action, and profile API keys never appear in the temporary JSON file.

## Branch-aware live indexing

Create the project's first index with `/index`, then use `/live` (or
`/live start`) to keep the current Git worktree indexed. Live mode uses the
project's selected provider profile and preset and publishes a target named
`live/<branch>` only after a complete build still matches the current worktree.

Useful commands:

```text
/live status
/live reconcile
/live stop
```

Filesystem changes are debounced and Git state is also polled, so commits,
checkouts, and branch switches trigger reconciliation even when they do not
produce an ordinary file event. Only one build runs at a time; changes arriving
during a build are coalesced into the next build. While a fresh live build is
pending, indexing, or failed, implicit project retrieval is paused rather than
serving an older target as if it described the worktree.

Switching from `task123` to `task456` does not remove either target. Scribery
keeps `live/task123` at its last ready immutable build and creates or advances
`live/task456`. Returning to the first branch advances its existing target.
Stopping live mode—or exiting the TUI—keeps the last ready targets and resumes
ordinary retrieval from the active one. The watcher is a foreground TUI
service; it is not a background daemon.
