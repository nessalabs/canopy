# Canopy — Detailed Solution Plan

## Context

Developers work on multiple branches at once, and reviewers want to *run* a branch, not just read its diff. Git worktrees solve branch switching, but nothing manages the rest: starting each worktree's app on its own ports, giving each an isolated fork of the database, and tracking what runs where. **Canopy** closes that gap: a self-hostable development-environment manager for git worktrees. This repo is currently a fresh Electron 44 + React 19 + Tailwind v4 + electron-vite scaffold with a mock "runs list" screen — it becomes the desktop client; everything else is net-new. (Note: the repo is not yet a git repository — `git init` first.)

## Goal

> Build Canopy: a client–server tool where a **`canopyd` daemon** (on a dev machine or shared server) manages **Workspaces** — one git worktree + supervised app services + auto-allocated ports + a forked database — and thin clients (web dashboard served by the daemon, Electron desktop app, `canopy` CLI) control it over REST + WebSocket. Any repo opts in with a `canopy.yaml`. Services run **on the host or in Docker, per user config**. Ships with **agent-readable docs** so a coding agent can onboard any app to Canopy unaided.

### Success criteria
1. Branch name → running, isolated app instance with its own DB fork in one action, with a clickable URL, from any client.
2. Two workspaces of the same repo run simultaneously with zero port/DB interference.
3. Destroy leaves nothing behind (worktree, processes, containers, ports, DB artifacts).
4. Onboarding a new repo = writing `canopy.yaml`; an AI agent pointed at Canopy's docs can write it correctly.
5. Live logs and status stream to all clients in real time.

### Non-goals (v1)
Not CI, not production deployment, no multi-node scheduling (one daemon = one machine), no per-user permissions (shared team token).

---

## Architecture

```
 canopy CLI ─┐
 web browser ┼── REST /api/v1 + WS (Bearer token) ──► canopyd ──► git worktrees
 Electron ───┘                                          │          ServiceRunners (host procs | docker)
                                                        │          port allocator
                                                        │          DB fork adapters (docker)
                                                        └── SQLite state (~/.canopy/state.db)
```

**Stack**: Node 22 + TypeScript everywhere. Fastify (REST) + ws (WebSocket), zod (canopy.yaml + API contracts, types via `z.infer`), better-sqlite3 (state), execa (processes/git), dockerode (Docker socket), commander (CLI), tsup (package builds). Electron keeps electron-vite.

**Monorepo** (npm workspaces — repo already uses npm):

```
canopy/
  apps/
    desktop/        # existing electron-vite scaffold, moved intact (src/main|preload|renderer)
    web/            # Vite SPA; build output served statically by canopyd at /
  packages/
    shared/         # @canopy/shared — zod schemas, API types, typed REST client, WS client
    ui/             # @canopy/ui — all screens/hooks + vendored nessa-ui components (one copy, both apps)
    daemon/         # @canopy/daemon — canopyd binary
    cli/            # @canopy/cli — canopy binary
  docs/             # agent-readable docs (see Docs section)
```

`apps/web` and `apps/desktop/renderer` are thin shells rendering `<CanopyApp>` from `@canopy/ui`; packages consumed as TS source via Vite aliases (no per-package build). `scripts/ui-add.mjs` relocation paths retarget `packages/ui/src`; Tailwind v4 `@source` scans it.

---

## Design decisions

### 1. `canopy.yaml` (per target repo; the worktree's copy wins)

```yaml
version: 1
name: acme-app
defaults:
  runtime: host                  # workspace-wide default: host | docker

ports:                           # named ports; canopyd allocates real numbers per workspace
  web: {}
  api: { preferred: 4000 }

databases:
  main:
    adapter: postgres            # postgres | sqlite (mysql later)
    version: "16"
    seed: { dump: ./db/seed.dump }   # populates the source-of-truth template
    env: DATABASE_URL
  cache:
    adapter: sqlite
    source: ./data/seed.db
    env: CACHE_DB_PATH

setup:                           # once per new workspace, in the worktree, env already injected
  - run: npm ci
  - run: npm run db:migrate

services:
  api:
    run: npm run dev:api
    cwd: apps/api
    runtime: host                # per-service override: host | docker
    env: { PORT: "${ports.api}" }        # templating: ${ports.*}, ${db.*.url}, ${workspace.*}
    health: { http: "http://localhost:${ports.api}/healthz", interval: 5s, retries: 12 }
    restart: on-failure          # never | on-failure (3 in 60s, backoff 1s→30s) | always
  web:
    run: npm run dev:web -- --port ${ports.web}
    depends_on: [api]            # start after api healthy; stop in reverse
    health: { tcp: "${ports.web}" }
  worker:
    runtime: docker              # docker runtime extras:
    docker:
      image: node:22             #   or dockerfile: ./Dockerfile.dev
      volumes: ["./tmp:/tmp/app"]
    run: npm run worker

env_file: .env.canopy            # optional generated dotenv in the worktree (for manual terminal use)
```

Every service also gets automatic `CANOPY_WORKSPACE`, `CANOPY_PORT_<NAME>`, `CANOPY_DB_<NAME>_URL`. Schema is zod-validated at repo registration and again at each workspace create.

### 2. ServiceRunner abstraction (configurable runtime — key requirement)

One supervision contract, two implementations chosen per service by `runtime:`:

```ts
interface ServiceRunner {
  start(ws, svc, resolvedEnv): Promise<RunningService>   // { id, kind: 'host'|'docker', pidOrContainerId }
  stop(rs, timeoutMs): Promise<void>                     // graceful (SIGTERM/docker stop) → kill
  status(rs): Promise<'alive'|'exited'>
  logs(rs): AsyncIterable<LogLine>                       // uniform line stream
}
```

- **HostRunner**: `execa(cmd, { shell: true, detached: true })` → own process group; kill via `process.kill(-pid)`; PID + start-time recorded for safe identity checks.
- **DockerRunner**: container from `docker.image`/`dockerfile`, worktree bind-mounted as workdir, named ports published to the allocated host ports, same env injection, logs via dockerode attach/log stream, labels `canopy.managed=true` + `canopy.workspace=<id>`.

Health checks (`http`/`tcp`/`cmd`), restart policy, `depends_on` ordering (topo-sorted, cycles rejected at validation), and log capture live **above** the runner, so both runtimes behave identically. Health checks always run **from the daemon** against localhost/published ports — one code path, and it verifies real reachability. Logs: per-service on-disk NDJSON with monotonic integer `offset` (50 MB cap/service) + in-memory ring buffer for instant backfill.

**Networking across runtimes** (the abstraction's leakiest seam — handle explicitly): docker services publish each named port with the **same number** on host and container side so `${ports.x}` means one thing everywhere; DB/service URLs resolve per consumer — host services get `localhost:<published-port>`, docker services get the container DNS name on a canopy-managed Docker network (`connectionInfo(inst, from: 'host'|'network')` in the DB adapter interface returns the right variant based on the consuming service's runtime).

**Status model** — per-service `pending|starting|healthy|unhealthy|restarting|stopped|exited(code)`; workspace status derived: `creating → provisioning → running | degraded | stopped | error | destroying`.

### 3. Worktrees

- Register repo: `canopy repo add <path>` — validates git repo + `canopy.yaml`; the registered clone is the primary checkout (canopy never touches its working tree).
- Layout: worktrees at `~/.canopy/worktrees/<repo>/<workspace-name>/` (slug names, not branch names); runtime data (logs, env, metadata) separately at `~/.canopy/workspaces/<id>/` so destroy can't eat logs.
- Branch modes: `--checkout existing` or `--new-branch feat-x --from origin/main` (fetch first). Branch already checked out in another worktree (git refuses): create the workspace on a generated branch `canopy/<workspace-name>` from that branch's tip and surface it clearly — never `--force` duplicate checkouts.
- Policies: dirty destroy refused with diffstat unless `--force`; always `git worktree prune` after destroy; `canopy doctor` repairs moved-repo gitdir breakage.

### 4. Ports

Daemon-config range (default `40000–44999`). Allocations persisted in SQLite (stable URLs across restarts), verified against the OS with a test bind, released only on destroy. Squatted ports get a retry-after-TTL skip mark.

### 5. Database forking (pluggable adapters)

Adapter interface: `ensureSource / fork / destroy / refreshSource / status / connectionInfo`, all artifacts Docker-labeled for cleanup.

- **Postgres (v1 choice): shared container + `CREATE DATABASE … TEMPLATE`.** One `canopy-pg-<version>` container per version; source of truth = `tpl_<repo>_<db>` seeded from the declared dump; fork is a near-instant file-level copy; destroy = `DROP DATABASE`. Chosen over per-workspace containers for speed and footprint; `dedicated: true` escape hatch planned for v2.
- **SQLite**: file copy into the workspace dir. Validates the abstraction trivially.
- **MySQL**: later, dump/restore based.
- `canopy db reset <ws> <db>` re-forks; `canopy db refresh <repo> <db>` re-seeds the template.

### 6. API + real-time

REST at `/api/v1` (Bearer token; routes for repos, workspaces, services, databases, logs, health). Create/destroy return immediately (`provisioning`/`destroying`); progress arrives as events. Errors: `{ error: { code, message, details } }` with stable snake_case codes.

**One multiplexed WebSocket** at `/api/v1/ws` (token via subprotocol — browsers can't set headers; keeps tokens out of URLs). Envelope `{ v, type, topic, seq, ts, data }`; topics `workspaces` and `logs:<ws>:<service>`. Sync model: REST snapshot returns `meta.seq` → subscribe `from: seq` → daemon replays from a ~2,000-event ring buffer then streams; events carry **full resources** (upsert-apply, self-healing); buffer miss → `reset` frame → client refetches. Same path handles cold start, reconnect (15 s heartbeat, backoff + jitter), and daemon restart. Log follow = REST backfill by offset, then WS from `nextOffset`.

### 7. State & recovery

SQLite `~/.canopy/state.db`: `repos, workspaces (desired_state), services (pid, pid_start_time / container_id), port_allocations, db_instances, events` (append-only timeline). Boot reconcile: verify recorded PIDs (start-time match) / containers by label; v1 ships **kill-and-respawn** on daemon restart, PID-adoption comes in the hardening milestone. Workspace creation is a **saga** — recorded steps with reverse compensations on failure (remove worktree, free ports, drop DB), workspace kept in `error` with its event trail.

### 8. Cleanup: `canopy doctor [--gc]`

Cross-checks state.db against: worktree dirs + `git worktree list`, Docker artifacts by `canopy.managed` label, `ws_%`/`tpl_%` databases in shared PG, and processes carrying `CANOPY_WORKSPACE` in env. Reports orphans both directions; `--gc` reclaims.

### 9. Clients

- **CLI** (`canopy`): `server start|stop|status`, `repo add|ls|rm|sync`, `create`, `up|stop|destroy`, `ls`, `logs [-f]`, `db ls|url|reset`, `config` (contexts in `~/.canopy/config.json`, chmod 600; env/flag overrides), `doctor`. Human tables + `--json` everywhere; exit codes 0/1/2/3/4/5.
- **Web dashboard**: served by canopyd; token entry → screens below.
- **Electron**: renderer talks to the daemon **directly** over HTTP/WS (no IPC proxy; `script-src 'self'` stays, `connect-src` widened) — one client code path shared with web. Main process adds: connection manager (multiple daemons), tokens in `safeStorage`, tray + notifications. Mock `RUNS` path deleted; shell renders `<CanopyApp>` with an `ApiProvider` + `Platform` context (`web|desktop`, `openExternal`, `notify`).
- **Screens (v1)**: workspace list (evolves `src/renderer/src/screens/workspace-screen.tsx` — cards, status filter, search), workspace detail (services table with clickable port links, per-service log tabs with follow, databases with masked URL + reset, start/stop/destroy), create-workspace dialog (repo → branch mode → name → autoStart), repos/settings (+ desktop-only Servers screen).

### 10. Docs — agent-readable, first-class deliverable

Goal: a coding agent pointed at Canopy can configure any app unaided.

- `docs/` in-repo, plain Markdown: `canopy-yaml-reference.md` (every field, annotated, with the zod schema as source of truth), `recipes/` (Next.js, Vite+API, monorepo, docker-runtime service, Postgres/SQLite seeding), `concepts.md` (workspace lifecycle, port/env injection contract), `api-reference.md` (generated from zod schemas), `cli-reference.md`.
- **`AGENTS.md` template**: `canopy repo init` scaffolds a starter `canopy.yaml` + an AGENTS.md snippet into target repos telling agents where the docs live.
- Daemon serves the docs: `GET /docs` (human HTML) and `GET /llms.txt` (index + flattened Markdown) so an agent can fetch everything from a running daemon.
- Every milestone below updates the docs it touches; the schema reference is generated, not hand-maintained, where possible.

---

## Milestones (each independently verifiable)

Fixture for all integration tests: `fixtures/demo-app` — two tiny Node HTTP services + `canopy.yaml` + a Postgres seed dump; vitest drives a real daemon on a random port.

- **M0 — Monorepo restructure**: `git init`; move scaffold to `apps/desktop`; create packages; patch `ui-add.mjs`, `components.json`, `dev.sh`. *Verify*: `./dev.sh` runs the unchanged mock app; `npm run typecheck`; `ui:add badge` lands in `packages/ui`.
- **M1 — Contracts + daemon skeleton**: zod schemas in `@canopy/shared`; canopyd with `/healthz`, token auth, SQLite schema, `repo add` with line-level yaml validation errors. *Verify*: contract tests; 401 without token; bad yaml rejected clearly.
- **M2 — Worktrees + ports**: create/destroy workspace (no services yet), both branch modes, persistent port allocation. *Verify*: worktree at expected path/branch; dirty-destroy refused then `--force` works; ports stable across daemon restart.
- **M3 — Supervision + logs + events (HostRunner)**: ServiceRunner interface + HostRunner, env templating, health checks, `depends_on`, restart policy, NDJSON logs + ring buffer, WS multiplexer with seq resume. *Verify*: fixture services respond on allocated ports; `kill -9` a service → restart observed; WS client gets backfill + live tail across a forced disconnect and a daemon restart.
- **M4 — DockerRunner**: `runtime: docker` services (image or `dockerfile` built + cached by content hash, worktree bind-mounted at `/workspace`, same-number port publishing, canopy Docker network, label-based lifecycle) behind the same contract. *Verify*: **the M3 supervision test suite runs parameterized against both runners** — this is the proof the abstraction holds; plus one host + one docker service in the same workspace reach each other and the DB; destroy removes containers.
- **M5 — DB fork adapters**: SQLite adapter, then Postgres shared-container TEMPLATE adapter (ensureSource/fork/refresh/destroy), URL injection into setup + services. *Verify*: two workspaces from one template — writes in one invisible in the other; destroy drops the DB; refresh reseeds.
- **M6 — CLI**: full command tree over `@canopy/shared` client, contexts, `--json`, `logs -f`. *Verify*: end-to-end bash script (create→ls→logs→destroy) asserting exit codes; `--json` snapshots.
- **M7 — Web dashboard**: four screens in `packages/ui`; `apps/web` built + served by canopyd. *Verify*: Playwright smoke — token entry → create workspace → watch status flip live → stream logs → destroy.
- **M8 — Desktop client**: connection manager, `safeStorage` tokens, direct daemon connect, CSP `connect-src` change, tray/notifications; packaged builds. *Verify*: same UI flows against a remote daemon; packaged app reconnects after daemon restart.
- **M9 — Hardening**: creation-saga fault-injection matrix (zero leftover artifacts at every step), `doctor --gc`, PID adoption replacing kill-and-respawn. *Verify*: injected failures roll back cleanly; planted orphan container GC'd; daemon restart adopts a live dev server without killing it.
- **M10 — Docs polish**: complete reference + recipes, `/llms.txt` + `/docs` endpoints, `canopy repo init` scaffolder. *Verify*: a fresh Claude session given only the docs URL writes a working `canopy.yaml` for the fixture app.

## Riskiest decisions (watch these)

1. **Process-group supervision on the host** — double-forking dev servers can escape the group; mitigated by group-kill + doctor's env-marker scan, and by the Docker runtime as the escape hatch.
2. **Shared Postgres container + TEMPLATE forking** — couples workspaces to one PG instance; template forks require zero connections to the template. `dedicated: true` is the planned v2 hatch.
3. **The uniform ServiceRunner contract, specifically networking** — `localhost` means different things inside a container; host↔docker service-to-service calls only work because of same-number port publishing and per-runtime URL resolution. A service that binds `127.0.0.1` inside its container or hardcodes `localhost` to reach a sibling leaks the abstraction. The parameterized M4 test suite is the guardrail.
4. **M0 restructure of a working scaffold** — `ui-add.mjs`, electron-vite root, and Tailwind source scanning all change at once; done first, in isolation, gated on `./dev.sh` + `ui:add` still working.

## Key existing assets to reuse

- `src/renderer/src/screens/workspace-screen.tsx` — mock runs list → workspace list screen.
- `src/main/index.ts` / `src/preload/index.ts` — IPC pattern for the new connections/safeStorage surface.
- `scripts/ui-add.mjs` + `components.json` — nessa-ui vendoring flow (retarget to `packages/ui`).
- `dev.sh` — extend for monorepo + daemon dev workflow.
