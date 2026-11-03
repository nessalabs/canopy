---
id: "terminals"
title: "Keep a shell while changing screens"
kind: "flow"
status: "implemented"
summary: "Socket followers do not own the PTY; explicit close requests its termination."
parent: "canopy"
sources:
  [
    "packages/daemon/src/terminals/service.ts",
    "packages/daemon/src/routes/terminals.ts",
    "packages/daemon/src/routes/fs.ts",
    "packages/daemon/src/worktrees/history.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Leave a terminal open while you inspect another worktree

The daemon starts a login shell in the chosen worktree, layering its environment over the daemon's variables. A terminal socket attaches to that PTY (pseudo-terminal). Changing screens, closing that socket or reloading the page only detaches a follower; the shell keeps running. Reattach to the same terminal ID to receive recent output and future events.

The terminal retains up to 256 KiB of recent characters, trimming at a line boundary where possible. This is bounded scrollback, not a durable full transcript. A shell's exit code remains on its terminal record so later attachments see it. Input and resize are ignored after exit.

Explicit terminal close deletes the in-memory record, removes listeners and calls kill when exit has not been observed. It does not wait for an independently verified process-tree cleanup receipt. Daemon closeAll applies that action to each terminal. Terminal state is not restart-durable and stopping a terminal cannot reverse commands already issued.

The file/history routes expose checkout files, trees and revision diffs used by the picker and separate file windows. They are views of the selected worktree/revision, not the shell's private filesystem. Read-only navigation is separate from agent rewind or git staging. API authentication applies to these operations; the desktop's native open actions have their own [owner](desktop.md).
