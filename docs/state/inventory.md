---
id: "inventory"
title: "Find the feature owner"
kind: "guide"
status: "implemented"
summary: "UI entry points, daemon owners and supporting modules are mapped separately from plans and external tools."
parent: "canopy"
sources:
  [
    "packages/daemon/src/server.ts",
    "packages/shared/src/api/routes.ts",
    "packages/ui/src/app.tsx",
    "package.json",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Follow a feature from the UI to its owner

This inventory maps implemented families at the page checkpoint. The shared routes table is the full endpoint vocabulary; server registration determines which handlers are reachable. UI routes compose these families rather than giving each endpoint a separate screen.

| Product surface or family                                                             | Explanation                     | Source owner and test family                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| Connect screen, saved connection, authenticated API, SSE                              | [Connect](connection.md)        | auth.ts, shared/client; cors and sse tests                                                |
| Command center, project scan/add/update, branches and checkout discovery              | [Projects](worktrees.md)        | projects/service, worktrees/service; projects/worktrees/remote-branch/watch               |
| Create checkout, copy/caches, setup, YAML lint/scaffold, project/app settings         | [Provision](provisioning.md)    | env/service, provision, config, settings; environment/config-load/scaffold/settings       |
| Host/Docker/Compose services, health, restart, recovery                               | [Services](services.md)         | env/services and runners; services-host/docker/supervisor/canopyd/health                  |
| Database forks, templates, lineage, generated env, ports                              | [Resources](resources.md)       | env/databases, ports, config/resolve; database/ports/resolve tests                        |
| Remove, batch jobs, salvage/trash restore/purge                                       | [Removal](destruction.md)       | worktrees/service,destroy-jobs,trash; matching test files                                 |
| Changes, file/commit/tree diffs, stage/hunks, exclusions, hidden paths, commit        | [Changes](changes.md)           | commit,git,history,shared/patch; commit/history/patch                                     |
| Local merge, push, PR read/create/actions/reviews, issues/assignees/attachments       | [GitHub](github.md)             | worktrees/merge,github; github/github-issues tests                                        |
| Agent messages, sessions, pins, transcript, fleet/presence, queue/interrupt/controls  | [Agents](agents.md)             | agents registry/adapters/turn-hub; Claude/Codex/turn-hub/fleet/session tests              |
| Tool approval and autonomy changes                                                    | [Permissions](permissions.md)   | agents/permissions,claude-live; permissions/claude-live                                   |
| Hook edit attribution, rewind, snapshots and provider checkpoints                     | [Edits](edits.md)               | agents/edit-diffs,claude-rewind; edit-diffs/rewind/shell-writes                           |
| Review comments, change graphs, graph conversations, whiteboard/plan and config agent | [Reviews](reviews.md)           | review,graphs,agents/config-agent,shared/plan; review/graphs/whiteboard/config-agent/plan |
| PTY terminal sockets, file browser and file windows                                   | [Terminals/files](terminals.md) | terminals,routes/fs,history; terminals/fs/history                                         |
| Electron shell/tray, platform actions, shared web screens                             | [Desktop](desktop.md)           | apps/desktop,apps/web,ui/app; shared UI test suite                                        |
| State migration and persistence                                                       | [Evidence](verification.md)     | db/migrate and014 SQL migrations; migrate tests with explicit current fixture failure     |

The shared package also owns schemas, patch algorithms, GitHub links, plan/graph folding, and vendored provider-stream translation. These are supporting APIs used by the above flows, not independent agent execution engines. Vendored UI and agent-stream code retain their upstream provenance; this task does not edit them.

Plans under docs/plans, lab avatar experiments and todo entries are not automatically shipped routes. Rust canopyd, Docker/database engines, git, gh, provider CLIs/SDK services and editor/terminal applications are external owners. A stubbed test of their adapter does not establish a live deployment of those systems.
