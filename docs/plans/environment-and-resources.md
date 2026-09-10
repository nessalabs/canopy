# Environment & Resources — architecture

Status: implementing 2026-09-09. Supersedes the "Not built yet" items in `docs/todo.md` for the
Environment tab, Resources tab, project settings, and the create-worktree options.

## Goal

Every worktree runs its application **in isolation**: its own ports, its own database forks
(Postgres, MySQL, SQLite, Redis), its own processes or containers (host, Docker, or a whole
Docker Compose stack), its own resolved env file — and Canopy shows what runs where, streams
logs, and measures CPU/memory per service. Worktrunk (`wt`) is the worktree backend when
installed; plain `git worktree` is the fallback.

## Where configuration lives

| File / store | Owner | Committed | Contents |
|---|---|---|---|
| `canopy.yaml` (repo root; the worktree's copy wins) | team | yes | *what runs*: `ports`, `databases`, `setup`, `services`, `env`, `env_file` |
| `~/.canopy/<project>/canopy.yaml` | this machine | no | the same file for a repo that should not carry one. Searched last, so a committed `canopy.yaml` always wins |
| `.config/wt.toml` | team, written by Canopy on request | yes | worktrunk hooks + `[list] url`. Canopy only rewrites the keys it owns and keeps everything else |
| `projects.settings_json` (state.db) | this daemon | no | Canopy project settings: worktrunk (path template, hooks, sync toggle), copy-files rules, cache rules, worktree defaults, cleanup |
| `~/.canopy/config.json` → `app` | this machine | no | editor/terminal launch commands, diff prefs, port range |
| `~/.canopy/worktrees-data/<id>/` | daemon | no | per-worktree runtime data: NDJSON logs, SQLite forks, Redis data, resolved env |
| `~/.canopy/<project>/worktrees/<name>/` | daemon | no | where new worktrees are checked out, from the project's path template (`{{ repo }}/worktrees/{{ name }}`) rendered into `worktreeRoot` (default `~/.canopy`). Existing worktrees keep the path they were created with |

The same zod validator (`@canopy/shared` → `parseCanopyYaml`) lints `canopy.yaml` in the
daemon and live in the settings editor, so the UI and the daemon never disagree.

## Domain model (shared schemas: `packages/shared/src/schemas/environment.ts`)

- `CanopyConfig` — the parsed, defaulted `canopy.yaml`.
- `ProjectSettings` — Canopy-owned per-project preferences (see table above).
- `WorktreeEnvironment` — attached to every `Worktree`: `state`, `desired`, `services[]`,
  `databases[]`, `ports`, `env[]`, `provisioning` (current/last run with steps),
  `caches[]`, `copiedFiles[]`, `envFile`.
- `WorktreeOptions` — per-worktree choices made at create time and editable later: included
  services, env overrides, DB fork source, cache strategy overrides, cache source, skip setup.
- `LogLine`, `ResourceSample`, `HostInfo`, `CanopyEvent`.

State machine per worktree (`EnvState`):

```
none ─provision→ creating → provisioning → stopped ─start→ starting → running ⇄ degraded
                     │              │                             │
                     └──── error ◄──┘ (retry from the failed step) └─stop→ stopping → stopped
destroying (terminal; the row is deleted when done)
```

`degraded` is derived: desired=running and some service is unhealthy/exited/failed.

## Provisioning pipeline (saga, resumable)

Steps, each idempotent so "retry from here" and "re-run setup" reuse them:

1. `create-worktree` — `wt switch [--create] <branch> [--base b] --no-cd -y --format json
   --config-set 'worktree-path = "<literal path>"'` (project hooks run: pre-start blocks,
   post-start in background). Fallback: `git worktree add`. The daemon sets `CANOPY_DAEMON=1`
   so Canopy's own `canopy provision` hook is a no-op during daemon-driven creation.
2. `copy-files` — project `copyFiles` rules (globs; copy or symlink) from the source checkout.
3. `link-caches` — cache rules per ecosystem (`node_modules`, `.venv`, `target`, `.next`,
   `.turbo`, …) with strategies `clone` (APFS `cp -c` / Linux `--reflink=auto`, falls back to
   copy), `copy`, `symlink`, `fresh`. Source is the primary checkout or a chosen sibling
   worktree. `reinstallOnLockChange` compares lockfile hashes and queues an install.
4. `allocate-ports` — one port per `ports.<name>`: stable hash of project/branch/name into the
   configured range, `preferred` honoured, bind-tested, persisted (`port_allocations`).
5. `fork-databases` — adapters: `sqlite` (file copy), `postgres` (one shared
   `canopy-pg-<version>` container, `CREATE DATABASE … TEMPLATE tpl_<project>_<db>`), `redis`
   (per-worktree container or host `redis-server`, own port), `mysql` (per-worktree container
   seeded from dump). Source: seed template, empty, or another worktree's fork.
6. `write-env` — resolve `${ports.*}`, `${db.*.url}` (plus the fork's parts: `${db.*.host}`,
   `${db.*.port}`, `${db.*.database}`, `${db.*.user}`, `${db.*.password}` for apps that need a
   different driver scheme such as `postgresql+asyncpg://`), `${worktree.*}`, `${project.*}` and
   layer env (yaml → project defaults → worktree overrides); write `env_file`.
7. `run-setup` — `setup:` commands in order with the resolved env, output streamed to the
   `provision` log; `if_changed` skips when inputs match the source checkout.
8. `start-services` — when autoStart.

Failure keeps the worktree in `error` with the step's error and a retry button; destroy tears
everything down (services → containers → DB forks → ports → wt remove / git worktree remove).

## Services

`ServiceRunner` (host | docker | compose) is the only thing that differs per runtime.
Health checks (`http` | `tcp` | `cmd`), `depends_on` ordering, restart policy with backoff,
log capture and resource accounting live above it in the supervisor.

- **host**: `spawn(sh -c run, { detached: true })` → own process group; stdout/stderr → NDJSON
  log file + ring buffer; kill = SIGTERM to the group, then SIGKILL after `stop_timeout`.
- **docker**: `docker run` with the worktree bind-mounted at `/workspace`, same-number port
  publishing, labels `canopy.worktree=<id>` / `canopy.service=<name>`; logs via `docker logs -f`.
- **compose**: `docker compose -p canopy-<id>-<svc> --env-file <env_file> up` as a supervised
  host process; `down -v` on destroy. Project name isolates containers/volumes/networks.

Restart on daemon boot is kill-and-respawn (recorded pids are verified by start time before
being killed); desired state is persisted so `running` worktrees come back.

Shutdown order is load-bearing: on SIGTERM the daemon first stops every service (graceful,
then SIGKILL after 12 s), then closes the HTTP server with `forceCloseConnections` so open
SSE streams cannot hold it open, then exits. `~/.canopy/canopyd.pid` refuses a second daemon
for the same home — two daemons supervising the same worktrees restart each other's services
and interleave the same log files (seen once during development).

## Resources

One `ps -axo pid,ppid,pgid,rss,time` per tick (2 s) attributes RSS and CPU-time deltas to
service process groups; `docker stats --no-stream` (4 s, only when containers exist) covers
containers; `os.cpus()` deltas give per-core host utilization. Last 90 samples per worktree
are kept in memory and streamed as `resources` events.

## Real-time

`GET /api/v1/events` (SSE, bearer via fetch) multiplexes `environment`, `resources`, `host`
and `worktree-removed` events with a `seq`; a 2 000-event ring buffer serves `?since=`,
otherwise `reset` tells the client to refetch. Logs stream on
`GET /worktrees/:id/services/:name/logs?follow=1&since=<offset>` with file-backed backfill.
The UI patches the react-query cache from events; git status keeps its 5 s poll.

## Worktrunk integration

- Creation/removal go through `wt` when installed (`HostInfo.worktrunk`), else git.
- Project settings → `.config/wt.toml` (`hooks`, `[list] url`) when "sync to repo" is on.
  The worktree-path template is a Canopy setting passed per call (`--config-set`); worktrunk
  keeps that key user-level.
- `canopy provision|teardown|start|stop --path <p>` (bin/canopy.mjs) let hooks call back into
  the daemon, so `wt switch --create x` in a terminal provisions the worktree too
  (`POST /worktrees/adopt`). Hooks always exit 0 and no-op when the daemon started them.

## Layout

```
packages/shared/src/schemas/environment.ts   contracts
packages/shared/src/canopy-yaml.ts           parse + lint canopy.yaml (daemon + UI)
packages/daemon/src/env/
  types.ts        internal interfaces (runner, adapter, log store, events, step ctx)
  config/         canopy.yaml loading, template interpolation
  settings/       project settings, wt.toml writer, app settings
  worktrunk/      wt CLI wrapper + git fallback
  ports/          allocator
  logs/           NDJSON store + ring + tail
  events/         bus + ring + SSE fan-out
  resources/      sampler
  databases/      adapter registry: sqlite, postgres, redis, mysql (+ docker helper)
  services/       runners (host, docker, compose), health, supervisor
  provision/      pipeline + steps + caches + copy-files + scaffold
  service.ts      EnvironmentService façade
packages/daemon/src/routes/environment.ts
packages/daemon/bin/canopy.mjs               hook-facing CLI
packages/ui/src/components/environment/      panels
packages/ui/src/components/resources/        meters
packages/ui/src/screens/*                    dashboard, settings, create, command center
```
