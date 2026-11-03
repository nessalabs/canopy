---
id: "resources"
title: "Fork databases and allocate ports"
kind: "flow"
status: "implemented"
summary: "Resource reset can destroy the old fork before replacement succeeds; stored ports are allocations rather than socket reservations."
parent: "canopy"
sources:
  [
    "packages/daemon/src/env/databases/registry.ts",
    "packages/daemon/src/env/databases/via-canopyd.ts",
    "packages/daemon/src/env/ports/allocator.ts",
    "packages/daemon/src/env/service.ts",
    "packages/daemon/src/env/config/resolve.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Give a worktree its own database and URLs

Provisioning resolves declared database adapters for SQLite, Postgres, MySQL and Redis. The registry wraps native adapters with optional Rust canopyd delegation. Docker and engine tools are external dependencies; a local adapter test does not establish those servers are available on another machine.

Resetting a fork can use the seed template, an empty source, or another known worktree. The source checkout must still exist when selected. The daemon records forking, destroys the old database, prepares the source and creates a new fork. On error it records an error with no connection URL; it does not restore the deleted fork. Save data you need before reset. Inspect the recorded error before retrying.

After success the daemon regenerates the environment file. Services already holding connections need a restart; changing .env.canopy is not a live connection migration. Refreshing a template is a separate project operation from resetting every existing fork. Lineage identifies where a fork came from, not ongoing replication.

## Ports are assigned numbers, not permanent reservations

A named allocation is stored for the worktree's lifetime. Existing rows are returned without probing, preserving stable URLs across daemon restarts. New allocations probe candidate ports and claim a unique daemon database row. A bind probe cannot prevent another process binding after it closes.

Rust canopyd owns declared service-port allocation. Server composition gives its calls a daemon-wide ports.json and configured range; the Node allocator mirrors those answers and allocates additional database ports. External-registry refusal triggers bounded allocation retries. This coordination prevents duplicate records under its contracts, not arbitrary external socket contention. A range change affects new allocation, not a promise existing bookmarks are renumbered.

Settings, generated environment values and fork URLs may include credentials. Their storage and use are development-machine concerns; the UI is not a secret vault or per-user database isolation boundary.
