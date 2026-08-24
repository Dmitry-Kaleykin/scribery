# scribery-code

Git-aware source snapshots, code indexing policy, managed projects, saved
recipes, retrieval targets, branch-aware live indexing, and code search services
for Scribery. The live service watches one managed Git worktree, publishes
stable `live/<branch>` targets, and gates implicit retrieval while a newer
worktree build is pending.
