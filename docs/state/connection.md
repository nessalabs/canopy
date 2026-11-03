---
id: "connection"
title: "Connect and follow updates"
kind: "flow"
status: "implemented"
summary: "Bearer authentication gates the API; browser subscriptions observe daemon-owned work."
parent: "canopy"
sources:
  [
    "packages/daemon/src/auth.ts",
    "packages/daemon/src/config.ts",
    "packages/daemon/src/server.ts",
    "packages/shared/src/client/sse.ts",
    "packages/ui/src/app.tsx",
    "apps/desktop/src/main/daemon-connection.ts",
  ]
sourceRevision: "b8d983c7b7b0221adb6d702207773f3a6c1752bd"
diagramLinks: {}
---

# Connect a client to the daemon

For a local desktop session, the main process reads the daemon token from CANOPY_HOME/token (default ~/.canopy/token) and its configured port. CANOPY_DAEMON_URL and CANOPY_TOKEN can select another connection. The web connection screen saves the supplied daemon URL and token through its connection store; entering the dashboard does not create a new daemon.

The daemon defaults to 127.0.0.1:9483. First startup creates its config and a random token; a newly created token file has mode0600. Existing token contents and permissions are reused. State.db, configuration, logs and worktree data belong to that daemon home.

Every /api/v1 request needs the shared bearer token. WebSocket upgrades may carry the token as the second subprotocol after `canopy`; the implementation does not use a query-string token. Static web assets and /healthz stay open. The CORS allowlist accepts loopback web origins, absent Origin and Electron's null Origin; that is separate from token authentication. This is a local trusted-development interface, not a per-user authorization system.

SSE subscriptions deliver observations while the daemon owns operations. A stream disconnect is not an operation cancellation receipt. Reconnect and inspect the relevant owner: agent turns, provisioning jobs and terminal shells each have their own retention and recovery rules. No universal durable event replay is promised.

Source and local tests cover route authentication/CORS and SSE parsing. They do not qualify an Internet-facing deployment or secure transport to an arbitrary remote URL.
