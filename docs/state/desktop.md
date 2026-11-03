---
id: "desktop"
title: "Use the desktop and menu bar"
kind: "flow"
status: "implemented"
summary: "The Electron main process owns tray subscriptions independently of its windows."
parent: "canopy"
sources:
  [
    "apps/desktop/src/main/index.ts",
    "apps/desktop/src/main/tray/state.ts",
    "apps/desktop/src/main/tray/index.ts",
    "apps/desktop/src/main/tray/panel.ts",
    "packages/ui/src/app.tsx",
    "packages/daemon/src/env/resources/sampler.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Check environments without opening the main window

On macOS the menu-bar panel lists project worktrees, environment states and service ports, with start/stop/restart and editor/terminal actions. The Electron main process holds the connection, so closing a window does not stop tray observations or daemon operations. The shared web UI does not itself become an Electron shell.

TrayState seeds projects, worktrees and host facts, then follows the daemon event stream. A closed or failed stream triggers backoff/reconnect and rereads connection settings. A failed refresh can leave stale rows until recovery; a displayed row is not a fresh health measurement merely because the panel opened. Try again resets the backoff.

Resource totals describe the supervised processes being sampled, while host facts provide machine capacity for comparison. They are not a complete accounting of everything running on the machine. Port links and open-in-editor/terminal hand off to another application; these actions do not prove the target server is healthy.

The common UI routes include command center, worktree dashboard, project create/settings, app settings, docs and separate file/diagram windows. Platform providers supply window and external-link behavior. Desktop connection discovery is described under [connect](connection.md); environment control still belongs to the daemon's [service owner](services.md).
