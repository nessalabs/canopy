---
id: "worktrees"
title: "Register and create a checkout"
kind: "flow"
status: "implemented"
summary: "Project registration and git checkout discovery precede asynchronous environment provisioning."
parent: "canopy"
sources:
  [
    "packages/daemon/src/projects/service.ts",
    "packages/daemon/src/projects/scan.ts",
    "packages/daemon/src/worktrees/service.ts",
    "packages/daemon/src/env/worktree/backend.ts",
    "packages/ui/src/screens/worktree-create-screen.tsx",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Add a repository and choose the branch to work on

Register an existing repository as a project. Scanning determines its canonical checkout, branch and detected ecosystem; duplicate registered paths are refused. The project stores a default base branch and settings. It is a record for a local repository, not a remote repository clone service.

The create screen selects a new branch, an existing branch or a remote branch. Remote selection is prepared as a local tracking branch before the worktree backend runs. A duplicate target path or project/name is refused. Production composition attaches EnvironmentService, so create returns its new row while [provisioning](provisioning.md) runs in the background.

Listing synchronizes git's worktree inventory with daemon records. Main and secondary checkouts, missing paths and managed worktrees have different roles; a record is not proof its directory still exists. Sessions can outlive a removed checkout and need a surviving run location when continued. Removing a project record is separate from deleting all git branches or remote repositories.

The Rust canopyd backend is selected when enabled and available; otherwise the backend uses git worktree. Its stable JSON error codes become API conflicts. Availability is cached briefly, so installing a binary does not instantly change an already cached result. The fallback has checkout creation/removal semantics, not full Rust environment ownership.

Existing checkouts discovered through git may be adopted and provisioned. Adoption is not a new branch. Choose [retry provisioning](provisioning.md) for setup failures and [destruction](destruction.md) for removal; issuing another create is not an idempotent retry of an uncertain request.
