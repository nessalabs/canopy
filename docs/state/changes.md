---
id: "changes"
title: "Stage and commit the actual index"
kind: "flow"
status: "implemented"
summary: "Checkboxes alter git staging; hunk writes refuse stale or
  unrepresentable selections."
parent: "canopy"
sources:
  [
    "packages/daemon/src/commit/service.ts",
    "packages/daemon/src/commit/exclude.ts",
    "packages/daemon/src/worktrees/history.ts",
    "packages/shared/src/patch.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
model: { "spec": "tla/HunkSelection.tla", "config": "tla/HunkSelection.cfg" }
diagramLinks: {}
modelCheck:
  sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
  checker: tlc-1.7.4
  date: 2026-11-03T09:07:38.750Z
  config: tla/HunkSelection.cfg
  modelDigest: 0660f58696ef00ab0841b425a2fea1d0261f331f83e04969cdb3700712f78b13
  states: 11
  held:
    - CurrentPatchOnly
    - PreserveUnrepresentedIndex
  broke: []
  unchecked: []
---

# Commit the changes you have staged

A file checkbox is git's index: selecting it stages the path, clearing it unstages it. A commit uses the index, including staging done in a terminal. Canopy does not reconstruct a private checklist at commit time. The changes/history views show working-tree, commit and tree comparisons; inspect the staged state before submitting.

For selected hunks, the client sends the displayed patch hash and selected hunk indices. The daemon recomputes the patch, rejects a changed hash, and verifies every currently staged atom can be expressed in those working-tree hunks. If staged text has since been edited to different text, a hunk rewrite can be refused as not_representable: stage or unstage the whole file deliberately instead of losing the earlier staging silently.

Index writes are queued per checkout within CommitService. Merge/rebase operations, conflicts, submodules and unsupported text modes have explicit refusal paths. Converted text from external diff drivers is not applied to the index. This local queue does not lock every external editor or terminal git operation; inspect refreshed results after a concurrent change.

## Keep paths out of a commit deliberately

The actions have different effects:

| Action             | Owner and effect                                               |
| ------------------ | -------------------------------------------------------------- |
| Ignore locally     | Writes git/info/exclude, outside committed .gitignore          |
| Add to .gitignore  | Changes a tracked project file that may itself need committing |
| Ignore local edits | Sets skip-worktree for this checkout's index entry             |
| Stop tracking      | git rm --cached stages a deletion while keeping working files  |

The hidden-path view lets the user undo supported hiding choices. Hiding is not encryption or a guarantee other git commands cannot stage a path.

A commit can run hooks/signing and has a bounded command timeout. An error or lost reply is not proof no commit exists: inspect HEAD, status and hook output before retrying. Local commit, push and pull-request creation are separate operations on [the GitHub page](github.md).

## Model boundary

HunkSelection checks two possible patch identities and an independent representability flag at the admission check. Controls ignore stale hash or unrepresentable staged content. Hash equality is abstract identity, not a cryptographic proof. The check and record are one model step; it excludes external edits or git writes between the real asynchronous reads/check and index update, mode validation and correctness of patch application. All properties are finite safety checks, with terminal deadlock checking disabled and no liveness claim. See [evidence](verification.md).
