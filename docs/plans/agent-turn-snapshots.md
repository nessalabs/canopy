# Agent turn snapshots: exact per-turn diffs from Claude Code hooks

Status: approved and implemented 2026-09-02 (`packages/daemon/src/agents/edit-diffs/`, migration
`002_agent_edits.sql`, `npm run hooks:setup`). Codex in-process snapshots and ref pruning remain
open — see `docs/todo.md`.

## Problem

The Agent tab's per-turn changes come from the transcript: edit-tool inputs plus write targets
parsed out of Bash text (`agents/shell-writes.ts`). That names files, not content, so the pane
shows each file's *current* uncommitted diff. It cannot show what a turn changed once a later
turn (or another agent in the same worktree) touched the same file, and it misses writes the
command text does not name (`npm install`, formatters, generated files).

Neither Claude Code nor Codex records file contents around tool calls. Claude Code's
`file-history-snapshot` only covers Edit/Write and its format is undocumented. The only exact,
agent-attributable signal is one Canopy takes itself: a snapshot of the worktree before and after
each tool call that can write, keyed by the call's `tool_use_id`.

## Mechanism

1. **Hook → daemon.** `~/.claude/settings.json` gains one `PreToolUse` and one `PostToolUse`
   hook, matcher `Bash|Edit|Write|MultiEdit|NotebookEdit`, command `canopy hook`. The command
   (a ~30-line script in `packages/daemon/bin/`) reads the hook JSON from stdin and POSTs it to
   `POST /api/v1/hooks/claude` with the token from `~/.canopy/token`. Exit 0 always, never
   blocks the agent; the daemon being down is a silent no-op.
2. **Snapshot = a git tree.** For the worktree whose path is the payload's `cwd`, the daemon runs
   `git add -A` into a throwaway index (`GIT_INDEX_FILE`) and `git write-tree`. Untracked files
   included, ignored files excluded, cost proportional to the dirty set. Pre stores the tree sha
   by `tool_use_id` in memory; Post snapshots again and runs `git diff-tree -r` between the two.
   No difference → nothing stored. A difference → one row per file.
3. **Storage.** Table `agent_edits(provider, session_id, tool_use_id, path, before_tree,
   after_tree, at)` in `state.db`. Trees stay alive with refs `refs/canopy/snapshots/<tree>`
   (one per distinct tree, so gc cannot prune them); refs are deleted with the worktree and by a
   prune of sessions older than N days.
4. **Diffing reuses the Git Diff stack.** `DiffSpec` gains `{ kind: 'trees', before, after }`.
   `git/diff.ts` gets one more row in its `LIST_BASE` / `PATCH_BASE` tables
   (`diff-tree -r before after`); `HistoryService.resolve` passes it through. `DiffExplorer`,
   `ContentPane`, `FileViewer` (`rev = after`) and line comments then work unchanged.
5. **Turn attribution.** `TranscriptItem` gains `toolUseId`. `GET /agent/sessions/:p/:sid/edits`
   returns the rows; the UI joins them to items by `toolUseId` and folds a turn to
   `{ before: firstRow.before_tree, after: lastRow.after_tree, files }`. The existing
   `filesByTurn` becomes the fallback when a turn has no rows (sessions before the hook, or
   terminal Codex sessions).

## Concurrency

Two agents in one worktree: a write by agent B between agent A's Pre and Post lands in A's
snapshot pair. The window is one tool call. Mitigation, cheap and table-free: mark a row
`attributed: false` when the path is neither the edit tool's `file_path` nor in
`shellWriteTargets(command)`; the UI shows those files with a "possibly another agent" marker.
Separate worktrees per agent (Canopy's intended model) have no overlap at all.

## Codex

Codex has no tool hooks. Turns Canopy runs itself go through the app-server, and the daemon sees
`commandExecution`/`fileChange` item start and end events, so it can take the same Pre/Post
snapshots in-process for those turns. Terminal-driven Codex sessions stay on the transcript
fallback.

## Engineering rules

- Snapshotting is one function `snapshotTree(cwd) → sha` and one `treeDiff(cwd, a, b) →
  ChangedFile[]` in `git/`, both behind the existing `GitRunner` so tests use the fixture repo.
- Hook dispatch is a table `{ PreToolUse: onPre, PostToolUse: onPost }`; no branching on tool
  names in the daemon — the settings matcher already chose them.
- No second diff pipeline: the `trees` kind is a table row in `git/diff.ts`, and the UI gets it
  for free through `DiffSpec`. Comments need `ReviewComment.spec`-style keying to attach to a
  trees diff; until then they attach to the working-tree diff as today.
- Tests: hook route with a fake `cwd` → fixture repo, Pre/Post pair produces rows and refs; a
  no-change pair produces nothing; `treeDiff` against `git diff` on the same fixture.
- Install is explicit: `canopy setup hooks` prints the settings block and asks before writing.

## Not in scope

Rewind (checking a tree out) — the refs make it possible later. Snapshots of files outside the
worktree. Per-hunk attribution when two agents edit the same file in the same call.
