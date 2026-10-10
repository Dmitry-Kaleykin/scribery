# scribery-code

Git-aware source snapshots, code indexing policy, managed projects, saved
recipes, retrieval targets, live indexing, and code search services for
Scribery. The live service watches one managed Git worktree and publishes a
temporary `live/current` target. It restores the previous retrieval selection
on shutdown and keeps a bounded cache of live builds for artifact reuse.
