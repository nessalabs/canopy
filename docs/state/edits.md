---
id: "edits"
title: "Inspect and rewind file changes"
kind: "flow"
status: "implemented"
summary: "Hook snapshots and provider checkpoints have different coverage and do not undo external systems."
parent: "canopy"
sources:
  [
    "packages/daemon/src/agents/edit-diffs/service.ts",
    "packages/daemon/src/agents/edit-diffs/snapshots.ts",
    "packages/daemon/src/agents/edit-diffs/hook.ts",
    "packages/daemon/src/routes/agents.ts",
    "packages/daemon/src/agents/claude-rewind.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Choose the evidence before rewinding a turn

Exact per-tool-call diffs use before/after git trees from Claude hooks, indexed by local records. Hooks are an explicit setup in Claude settings; without them, the UI can fall back to the paths named by tool calls. A named file is not exact before/after evidence. Concurrent filesystem activity can affect a whole-worktree snapshot; do not attribute every captured byte solely from a tool's name.

A Canopy snapshot rewind restores the checkout's captured files, including file changes made by shell commands. It does not reverse network calls, databases outside those files or other remote effects. The endpoint resolves a managed checkout and checks the requested tree is a pinned Canopy snapshot before applying it.

The current checkout is snapshotted first, including for a dry run. A dry run reports changed paths and line counts without restoring the target. Applying deletes paths added since the target and restores its other changed paths. The index stays where the user put it: a rewind is not an instruction to stage or unstage. Inspect the [Changes view](changes.md) afterward.

Without a Canopy tree, the provider's own rewind/checkpoint mechanism is used where supported; that can cover only its file tools. A response may be HTTP200 with canRewind false and an explanation. Read the result, not just the HTTP code. Partial filesystem failure is not a transaction rollback; retained snapshots support inspection and recovery but do not promise every restore can complete.
