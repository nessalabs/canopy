---
id: "agents"
title: "Continue and interrupt agent turns"
kind: "statechart"
status: "implemented"
summary: "A daemon-owned turn survives follower disconnect; interrupt is a separate provider action."
parent: "canopy"
sources:
  [
    "packages/daemon/src/agents/turn-hub.ts",
    "packages/daemon/src/agents/registry.ts",
    "packages/daemon/src/routes/agents.ts",
    "packages/daemon/src/agents/sessions.ts",
    "packages/daemon/src/agents/fleet.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
diagramDetails:
  [
    {
      "diagram": 0,
      "node": "Detached",
      "section": "Stop, queue and change a live turn",
    },
    {
      "diagram": 0,
      "node": "Remove",
      "section": "Live ownership and saved history",
    },
  ]
---

# Continue a conversation while changing screens

The Agent tab uses Claude or Codex adapters when available. A new message starts a daemon-owned turn: TurnHub drains provider events independently of the HTTP follower. Closing the tab, switching worktrees or reloading the page does not interrupt the agent. Follow the same live session to receive its buffered events and subsequent events.

```mermaid
flowchart TD
    Send[Submit message] --> Gate[Reject an already running known session]
    Gate --> Turn[Daemon drains provider events]
    Turn --> Follow[Clients replay and follow events]
    Follow --> Detached[Client disconnects only itself]
    Turn --> End[Provider stream ends or errors]
    Interrupt[Explicit provider interrupt] --> Turn
    End --> Remove[Remove only this turn from live registry]
```

## Live ownership and saved history

Known provider/session pairs admit one live turn in this registry. New sessions learn their ID from an event. Cleanup compares the stored turn identity before deleting the registry entry, so an old drain cannot erase a replacement. Buffers last for the turn lifetime; completed history comes from provider session storage, not a durable TurnHub journal.

Session listing, fleet/presence and pinning combine local records with provider evidence. Missing or unauthenticated providers contribute no sessions rather than proving none ever existed. Continuing from a removed checkout requires a real surviving cwd; the send route refuses an explicitly nonexistent directory. Provider capabilities are probed lazily and may be refreshed.

## Stop, queue and change a live turn

Interrupt, queued message and live controls are adapter operations. A no_live_turn refusal means this daemon cannot address that live provider turn; the session might have ended or be driven elsewhere. An accepted interrupt is not a rollback of files or remote actions. Inspect subsequent events and results before assuming the agent did nothing.

Tool permissions use a [separate pending-request desk](permissions.md). For file recovery use [edit evidence and rewind](edits.md). Claude SDK/terminal sessions, Codex app-server/replay and vendored agent-stream mapping have different capabilities; the unified transcript does not manufacture unsupported operations.
