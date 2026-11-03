---
id: "provisioning"
title: "Create and retry an environment"
kind: "statechart"
status: "implemented"
summary: "Provisioning records ordered steps and leaves partial effects
  available for inspection and retry."
parent: "canopy"
sources:
  [
    "packages/daemon/src/env/service.ts",
    "packages/daemon/src/env/provision/pipeline.ts",
    "packages/daemon/src/env/provision/steps.ts",
    "packages/shared/src/canopy-yaml.ts",
    "packages/daemon/src/env/config/load.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
model: { "spec": "tla/ProvisionOrder.tla", "config": "tla/ProvisionOrder.cfg" }
diagramLinks: {}
diagramDetails:
  [
    { "diagram": 0, "node": "Failed", "section": "What remains after failure" },
    { "diagram": 0, "node": "Done", "section": "Configuration and ownership" },
  ]
modelCheck:
  sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
  checker: tlc-1.7.4
  date: 2026-11-03T09:07:40.848Z
  config: tla/ProvisionOrder.cfg
  modelDigest: ccecf02ec3b67a132d21619cdde72d9564d6071c51f5de0c5c8c0593f5272cc9
  states: 8
  held:
    - NoStageAfterFailure
    - NoStageAfterObservedAbort
  broke: []
  unchecked: []
---

# Create a checkout, then follow provisioning

Creating a worktree inserts its local record and queues provisioning. The returned worktree is acceptance of that work, not evidence that setup finished. For example, a checkout may exist while dependency installation is still running. Follow its environment status and per-step log before starting work that needs the database or services.

```mermaid
stateDiagram-v2
    [*] --> Queued
    Queued --> Active: Begin selected step
    Active --> Next: Step completes or is skipped
    Next --> Active: More pending steps
    Next --> Done: All selected steps settled
    Active --> Failed: Step throws or cancellation observed
    Failed --> Queued: Explicit retry from chosen step
```

## What remains after failure

The pipeline stops at the first failed step; it does not roll back earlier steps. A failing setup command may itself have changed files or remote systems. Cancellation is checked before each pending step and passed to step implementations; it does not establish that an arbitrary command performed no effects. Inspect the failed step and logs before rerunning setup with side effects.

A default retry begins at the previous failed step, or copy-files when none failed. Steps before the selected start preserve done/skipped outcomes; other earlier steps are marked skipped. These are records of what this runner chose to do, not a fresh verification that the resources still exist. The provision API returns when the run starts, while steps continue in the background.

## Configuration and ownership

canopy.yaml supplies validated service, resource and setup definitions. The settings screen can lint and scaffold it; project and per-worktree options control copying, caches and autostart. With no configuration, provisioning can still create the worktree and copy files/caches; its final environment state is none. That does not mean checkout creation failed.

The daemon resolves generated environment variables and writes .env.canopy. Ports and database fork URLs come from their [resource owners](resources.md). Existing services are stopped before reprovisioning a live environment. The daemon serializes lifecycle operations per worktree, and refuses provisioning while already creating/provisioning or destroying.

The optional Rust canopyd backend and plain-git fallback differ. The fallback creates/removes checkouts; it is not a replacement implementation of every port, database and run-control capability. Setup commands execute the repository's configured work and may require its own dependencies.

## Model boundary

ProvisionOrder represents two stages, failure of the first and an abort flag. It checks the next stage does not start after a prior failure or already-observed abort. Controls allow each forbidden continuation. It does not claim cancellation undoes an in-flight stage, that setup is idempotent, or that retry can safely repeat arbitrary external effects. Restart/retry and skipped-stage selection are outside this two-stage bound. All properties are finite safety checks, with terminal deadlock checking disabled and no liveness claim. See [evidence](verification.md).
