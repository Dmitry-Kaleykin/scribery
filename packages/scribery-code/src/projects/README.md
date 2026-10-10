# Managed projects, indexing recipes, and retrieval targets

The projects module owns managed-project identity, manifests, catalog listing,
deletion, saved indexing recipes, indexing orchestration, and retrieval-target
selection. CLI, UI, and MCP interfaces depend on this module; none owns project
state.

## Saved indexing recipes

Every successful managed index writes
`~/.scribery/indexes/<project-identifier>/indexing-recipe.json`. The recipe
contains the named provider profile or inline embedding configuration, target,
retention depth, encoding fallback, chunk size, dirty-tree policy, and include
or exclude patterns used for that build.

```sh
scribery preset set legacy-web \
  --profile local-qwen \
  --chunk-size 3000 \
  --windows-1251
scribery index . --preset legacy-web --target release128
scribery recipe
scribery reindex
```

Recipe publication happens only after a ready build is stored and its target is
published. A failed index therefore leaves the previous recipe and target
usable. Recipes that refer to a named profile use the current profile on the
next reindex. Inline recipes preserve the effective provider configuration from
the original direct-argument command.

An indexing preset is only a template for the first command. Its resolved
project settings are copied into the concrete recipe, which contains no preset
reference. Later preset edits therefore cannot change an established project's
`reindex` behavior.

`ProjectIndexingService` is the UI-facing orchestration boundary. It performs
provider diagnostics, indexing, logging, target publication, retention cleanup,
and recipe persistence. Its event callback emits versioned discriminated
events for diagnostics, coordinator progress, target publication, recipe
storage, and operation completion.

`ProjectSearchService` is the corresponding managed-project retrieval boundary.
It resolves the active target or requested build, loads an optional named
provider profile, opens storage read-only, and returns attributed semantic,
reranked, and context-expanded results. A UI does not need to handle database
paths, build identities, or provider construction itself.

`ProjectInspectionService` resolves the same selection and returns every stored
chunk for one normalized project-relative source path. It is the boundary used
by chunk previews and source inspection views.

## Named retrieval targets

A retrieval target is a project-local alias for one immutable ready
`indexBuildId`. Target names are manual labels and do not inspect, change, or
track Git branches:

```text
release128 -> index-build_...
develop    -> index-build_...
```

One target or exact build can be selected for project retrieval. The state is
stored atomically in
`~/.scribery/indexes/<project-identifier>/retrieval-targets.json`; nothing is
written into the indexed source tree.

Index, assign, and activate a target after the build becomes ready:

```sh
scribery index . --profile <name> --target release128
```

Index-driven assignment retains one replaced build by default. Override that
rollback depth with `--keep-replaced-builds <n>`; zero keeps only the newly
published build. Once the target has been advanced atomically, builds released
from its history are deleted unless another target or an exact active-build
selection references them. Shared chunks and embeddings are reclaimed only
after their final build reference disappears. A failed or incomplete index
does not advance the target or trigger cleanup.

Manage selection independently of indexing:

```sh
scribery retrieval list
scribery retrieval status
scribery retrieval set release128 --build <indexBuildId>
scribery retrieval switch release128
scribery retrieval switch --build <indexBuildId>
scribery retrieval rename release128 release-128
scribery retrieval remove release128
```

Commands resolve the managed project from the current directory. `--project`
accepts an indexed root, project identifier, or managed database path when an
explicit project is needed.

Target names are scoped to one managed project, so projects may use identical
branch names without conflict. Renaming is an atomic catalog-only change: it
preserves the selected build and retained build history, and updates an active
target selection to the new name without reindexing.

An index command with `--target` makes that target active even if another
selection was active before it. A target cannot be removed while active.
Assigning and switching reject missing or non-ready builds. Manual
`retrieval set` remains a labeling operation and does not apply index retention
or delete builds.

MCP reads the active selection before every project search and chunk-inspection
call. It therefore observes a CLI switch without restarting the MCP process.
Explicit per-call MCP build selection overrides the active target. With no stored
selection, retrieval falls back to the newest ready build for backward
compatibility.

Documentation has its own active builds and source tags. Project retrieval
targets do not participate in documentation lookup, filtering, or lifecycle.

## Live indexing

`ProjectLiveIndexingService` watches one existing managed Git project and owns
one temporary `live/current` target. Its session ID is stored on the target;
the actual branch (including detached/unborn labels) is stored in session
status. Target listings expose it as `live`, separately from ordinary `targets`
and `targetCount`. Permanent release, stage, and stable targets are explicitly
managed through normal indexing and retrieval commands.

The scheduler combines filesystem events (excluding `.git` and `node_modules`)
with Git polling. Its request options and defaults are:

| Option | Default |
| --- | --- |
| `debounceMilliseconds` | 750 |
| `maximumWaitMilliseconds` | 5,000 |
| `minimumBuildIntervalMilliseconds` | 5,000 |
| `pollIntervalMilliseconds` | 2,000 |
| `cacheBuildLimit` | 20 |

Continuous events cannot extend the debounce beyond the maximum wait, subject
to the build interval and any running reconciliation. Only one reconciliation
runs at a time, with one scheduled follow-up for changes received during it.
Manual `reconcile()` skips debounce, deliberately requests indexing, and still
observes the minimum build interval.

Before indexing, the service prepares the selected source snapshot and compares
its paths/content hashes, source selection, HEAD, and branch with the last
published snapshot. Unchanged snapshots cause no build or retrieval pause.
Include/exclude and discovery rules apply to this check. Git status alone does
not detect further edits to an already-modified file; filesystem events provide
those triggers. Prepared bytes are passed to indexing without another initial
read. Live builds allow dirty worktrees, reuse compatible artifacts, diagnose
the provider once after a successful build, and do not overwrite the saved
manual indexing recipe or preferred manual target.

Publication builds an immutable index first, then compares a fresh content
snapshot and Git identity before assigning `live/current`. It checks again
after assignment before reporting ready. Superseded completed builds are cached
and the next build goes through the scheduler. Sustained edits can prevent a
build from becoming ready even though the scheduler continues starting builds.

Live cache ownership and recency are persisted in `live-build-cache.json`.
Only tracked live builds are evicted; reusing an untracked manual build does
not make it cache-owned. The newest `cacheBuildLimit` unreferenced live builds
are kept, plus builds protected by targets/history, active selection, the saved
previous selection, or a building status. This is separate from manual target
`keepReplacedBuilds` retention. Compatible reuse searches ready builds regardless
of whether they have targets or which branch created them.

Session status, the previous selection, and the cache limit are written
atomically to `live-indexing.json` and refreshed by a heartbeat. Implicit search
and inspection reject fresh pending/indexing/failed sessions or a ready session
whose build differs from the active selection. Explicit immutable build lookup
remains available.

Shutdown atomically restores the previous selection and removes the owned
temporary target; cached builds remain. With an implicit latest-ready selection,
the pre-session build is saved as an exact selection to prevent a live build
from becoming the fallback after shutdown. A newer external selection is
preserved. Target reads and implicit retrieval recover expired/stopped sessions
using the same ownership check. Sessions expire after ten seconds without a
heartbeat. The TUI stops the foreground service on exit; no daemon is installed.

`ProjectRetrievalTargetService.cleanupLegacyLiveTargets()` (TUI `/live cleanup`)
explicitly removes old `live/<branch>` targets after live mode is stopped,
registers their builds in the live cache, and preserves an active legacy build
as an exact selection. It does not delete builds during migration.
