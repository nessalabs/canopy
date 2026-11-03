---
id: "reviews"
title: "Send review comments or a config draft"
kind: "flow"
status: "implemented"
summary: "Local send markers, provider output and saved configuration are separate facts."
parent: "canopy"
sources:
  [
    "packages/daemon/src/review/service.ts",
    "packages/daemon/src/routes/review.ts",
    "packages/daemon/src/graphs/store.ts",
    "packages/daemon/src/graphs/brief.ts",
    "packages/daemon/src/agents/config-agent.ts",
    "packages/daemon/src/env/config-check.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Send selected comments to an agent

Review comments are stored locally by worktree and can be selected into an agent prompt. Preparing a review marks them sent before starting the streaming turn. When a new session ID arrives, the comments are associated with it and that session is pinned. A provider error before producing content rolls back the stream's send marks; after content, the marks remain.

There is a narrower admission gap: the route prepares first, then asks TurnHub to start. If an existing session is already running, that start refuses and the prepared sent markers can remain without a provider turn. A sent label therefore is not proof the provider accepted the prompt. Inspect the conversation and select comments explicitly when retrying this case; do not infer the review completed from the label.

Graphs of changes have stored conversation links, newest answers and hunk/line information. Whiteboard/plan helpers interpret and fold structured agent output; a diagram is review material, not execution of the depicted plan. GitHub review posting is a separate [external action](github.md).

## Propose configuration, then save it deliberately

The Canopy Agent's propose tool lints YAML and shows an unsaved draft. It does not write canopy.yaml. The user reviews and saves the editor contents. Its check tool runs the saved configuration in a temporary worktree, provisions/starts it and reports results with a deadline; cleanup uses the throwaway path without salvage. A proposal passing lint is not a service startup pass, and a check result is evidence for that configuration/environment only.

These are distinct flows from ordinary coding messages: toolkit instructions and allowed tools are adapter inputs, not a general proof an external provider obeys every instruction. Temporary-check cleanup is an attempt through the normal destruction owner; its failure must remain visible in the report.
