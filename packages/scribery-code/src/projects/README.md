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

## Branch-aware live indexing

`ProjectLiveIndexingService` watches one existing managed Git project and
automatically owns targets under the `live/` namespace. A normal branch maps
directly to a readable project-local target:

```text
release7 -> live/release7
task123  -> live/task123
```

Detached and unborn worktrees receive explicit fallback target names. Branch
names that cannot be represented safely as retrieval targets are deterministically
slugged with a short hash, so distinct Git refs cannot silently collide.

The service responds to recursive filesystem events (excluding `.git` and
`node_modules`) and polls the complete Git working-tree fingerprint. Events are
debounced for 750 ms by default. Only one build runs at a time, and events that
arrive during it are coalesced. Live builds allow dirty worktrees, reuse existing
artifacts, diagnose the provider once per live session, and do not overwrite the
project's saved manual indexing recipe.

Publication is deliberately two-phase: Scribery first creates an immutable
ready build without changing a target, then verifies that the branch and full
Git fingerprint still match. Only then does it assign and activate the
`live/<branch>` target. It verifies the worktree again after publication and
never marks an obsolete generation ready. A failed or superseded build cannot
advance a live target.

The current session state is written atomically to
`~/.scribery/indexes/<project-identifier>/live-indexing.json` and refreshed by
a heartbeat. Implicit search and chunk inspection fail closed while a fresh
session is pending, indexing, failed, or points at a build other than the active
selection. An explicit immutable `indexBuildId` remains available for deliberate
historical inspection. Stopped and expired sessions no longer gate retrieval.

Live targets are preserved across branch switches and service shutdown. Because
each target references an immutable build, switching away from unfinished work
requires no cleanup: its last successful `live/<branch>` target remains until it
is advanced or manually removed. The initial TUI integration runs the service
in the foreground and stops it with the TUI; it does not install a daemon.
