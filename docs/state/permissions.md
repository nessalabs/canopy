---
id: "permissions"
title: "Answer the current tool request"
kind: "statechart"
status: "implemented"
summary: "A permission reply must address the pending session and request; abort
  settles as deny."
parent: "canopy"
sources:
  [
    "packages/daemon/src/agents/permissions.ts",
    "packages/daemon/src/routes/agents.ts",
    "packages/daemon/src/agents/claude-live.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
model:
  {
    "spec": "tla/PermissionDecision.tla",
    "config": "tla/PermissionDecision.cfg",
  }
diagramLinks: {}
diagramDetails:
  [
    {
      "diagram": 0,
      "node": "Pending",
      "section": "What changing autonomy can answer",
    },
  ]
modelCheck:
  sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
  checker: tlc-1.7.4
  date: 2026-11-03T09:07:39.869Z
  config: tla/PermissionDecision.cfg
  modelDigest: e2bcc45eb804cdb7017bb4aca62fcdc9d063335d30f7b6ab47e4bd12193479ba
  states: 24
  held:
    - CurrentRequestOnly
    - ForcedAskRequiresReply
  broke: []
  unchecked: []
---

# Answer a permission in the session that asked

An agent may pause before a tool call. Use the pending request displayed for that session; the daemon routes the answer by provider, session ID and request ID. A late or duplicate answer receives unknown_permission_request when no matching prompt remains. It does not grant a future tool call permission.

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Allowed: Matching session and request allows
    Pending --> Denied: Matching reply denies or turn aborts
    Pending --> Pending: Foreign or stale reply refused
    Allowed --> [*]
    Denied --> [*]
```

## What changing autonomy can answer

PermissionDesk parks a promise under session and request. Settling removes it before resolving the provider callback. Aborting settles deny rather than leaving the SDK waiting on a rejected promise. Changing autonomy may allow pending requests, except excluded tools and prompts explicitly forced by a user's ask rule. A forced request remains for a person to answer.

This desk is one provider adapter's local pending-request mechanism. Provider capability checks and live controls determine which operations that adapter supports. It is not a proof of the provider's internal policy enforcement or arbitrary tool behavior. It assumes request IDs identify distinct outstanding asks; callers must not reuse one for concurrent requests in a session.

## Model boundary

PermissionDecision represents one pending ask and two independent composite session/request identities. It checks explicit replies match the pending identity and automatic allowance excludes a forced ask. Abort removes that ask; there is no future ask in this bound. Controls remove each matching/forced guard. It assumes unique pending keys and excludes provider internals, concurrent duplicate-key insertion, and authorization outside this adapter. All properties are finite safety checks, with terminal deadlock checking disabled and no liveness claim. See [evidence](verification.md).
