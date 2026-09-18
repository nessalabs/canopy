# Moving the environment onto canopyd

Status: in progress, started 2026-09-18. Decided by the user the same day: **everything the Node
daemon does for a worktree's environment moves into [canopyd](https://github.com/nessalabs/canopyd)**,
and services are supervised by a long-lived `canopyd run` child per worktree.

The Node daemon keeps what is about *clients*: the REST + SSE API, project and worktree state in
SQLite, agent sessions, git diff and commit. What is about *a worktree's running environment*
becomes a `canopyd` command, and the daemon turns into the thing that calls it and relays the
result.

## Where each piece stands

| Piece | Node today | canopyd | Status |
|---|---|---|---|
| Create / remove a worktree | `env/worktree/backend.ts` wrapper | `new`, `rm` | done (before this plan) |
| Copy gitignored files, caches | wrapper | `copy` | done (before this plan) |
| Port allocation | wrapper | `ports` | done (before this plan) |
| Setup steps | wrapper | `setup --env` | done (before this plan) |
| **Host services: spawn, health, deps, restart, crash budget** | `CanopydSupervisor` | `run --json --control` | **done in this branch**, for eligible worktrees |
| **Service logs** | tailed from canopyd into the log store | `logs -f --json --since` | **done in this branch** |
| **Secrets to services** | child environment | `--env KEY` | **done in this branch** |
| **Writing `.env.canopy`** | `EnvironmentService.writeEnv` | `env --write --env KEY` | **done in this branch** (the daemon still resolves, for the Variables panel) |
| Env resolution for display | `env/config/resolve.ts` | `env --json --reveal` | later: needs `${db.…}` and the settings layers in canopyd |
| **Docker and Compose services** | `CanopydSupervisor`, same as host | attached `docker run --rm --init` / `compose up` | **done in this branch** (canopyd 0.4.0) |
| **SQLite and Postgres forks** | `databases/via-canopyd.ts` delegates, in-process adapter as fallback | `db fork\|ls\|reset\|drop\|template`, `${db.…}` | **done in this branch** (canopyd 0.3.0 and 0.5.0) |
| MySQL, Redis forks | `env/databases/{mysql,redis}.ts` | parse and warn; `db fork` refuses them | needs crate work |
| Resource sampling (CPU, memory) | `env/resources/sampler.ts` | nothing | needs crate work |
| `canopy.yaml` lint and scaffold | `@canopy/shared` zod + `env/config/scaffold.ts` | `config check`, `config init` | later |
| Plain-git fallback | `backend.ts` | — | removed last, once nothing needs it |

## What landed in canopyd for this (0.2.0 to 0.5.0)

- `--env KEY=VALUE` on `env`, `up`, `down`, `ps`, `run` (it was only on `setup`), through the
  resolver's own override layer. `--env KEY` with no value takes it from canopyd's environment,
  which is how secrets are passed: arguments are visible to every user through `ps`.
- `env --json --reveal`, for an embedder that stores the table and masks it itself.
- `run --control`: `start|stop|restart <service>` on stdin. A requested stop *holds* the service
  against its restart policy; a requested start wipes its restart history; end of input stops
  everything, so a daemon that dies does not orphan services.
- `run` makes a dependent wait for a dependency's health check, bounded by that check's own
  window plus five seconds. Canopy's own `canopy.yaml` depends on this: the web client reads a
  token the daemon writes at boot.
- `logs --offsets` / `--since <offset>` pages and a `logs -f --json` event stream, with byte
  offsets so a reader resumes with a seek.
- 0.3.0: `db fork|ls|reset|drop` with a SQLite adapter, forks recorded in the worktree's state
  directory and removed by `rm`; the fork's URL in the environment (`env:` key,
  `CANOPY_DB_<NAME>_URL`) and as `${db.<name>.url}` / `${db.<name>.file}`.
- 0.4.0: `runtime: docker` and `compose:` services, run attached so the docker CLI is an
  ordinary supervised process: same logs, health, restart policy and `down`, with `-e KEY` for
  values, `--init` for a prompt stop, and a `docker rm -f` / `compose stop` backstop. Checked
  against a real Docker daemon: `down` in half a second, nothing left behind.
- 0.5.0: Postgres forks through the docker CLI alone: one `canopy-pg-<version>` server, a
  template per project, `CREATE DATABASE … TEMPLATE` per worktree, dump / SQL / command seeds,
  `db template` to rebuild. Same server, port, credentials and template names as this daemon,
  so the two interoperate. Checked against a real `postgres:16`.

## How the daemon decides

`EnvironmentService.canopydCanRun` picks the supervisor per worktree and logs the reason to the
worktree's `supervisor` stream when it has to fall back. canopyd runs a worktree when all hold:

- the project has not turned the tool off, and `canopyd` ≥ 0.2.0 is on PATH
- the worktree is on a branch (canopyd addresses worktrees by branch)
- `canopy.yaml` is inside the checkout, where canopyd can find it too (not the project-home copy
  under `~/.canopy/<project>/`)
- any docker or compose service needs canopyd ≥ 0.4.0
- if a service refers to `${db.…}`, every fork was made by canopyd (`detail.managed_by`), since
  it resolves the reference only against its own forks: SQLite and Postgres today. Worktree-level
  values reach it either way, as overrides.

Otherwise `WorktreeSupervisor` runs it in-process exactly as before. Both implement `Supervisor`.

## Known differences under canopyd

- CPU and memory for a docker service are read from its container, found by the name canopyd
  gives it (`canopydContainerName`, pinned by a test on both sides). A compose stack has no
  single container to ask about, so it shows no usage yet.
- A service's log no longer separates stderr from stdout: canopyd redirects both into one file so
  that nothing has to stay alive to pump a pipe. Lines arrive as `out`, with `sys` lifecycle
  markers added by the daemon. Timestamps are when the daemon saw the line.
- The daemon no longer adopts or reaps by pid on boot for these worktrees: the previous run saw
  its control pipe close and stopped its services. `reap` is `canopyd down`, as a backstop.
- Restart counting resets on a manual restart, as before; the backoff and the budget are
  canopyd's defaults (1 s doubling to 30 s, 5 restarts in 60 s), which match what the daemon used.

## Next, in order

1. **Redis and MySQL forks in the crate**, on the `container` module's docker calls. SQLite and
   Postgres are done; with the rest, the `${db.…}` clause of the eligibility check goes.
2. **Drop `WorktreeSupervisor` and `runners/`** once the fallback in step 5 goes: they are now
   only reached when canopyd cannot be used at all.
3. **Resource sampling** as `canopyd ps --json` fields or a `stats` command.
4. **Env resolution for display** from `env --json --reveal`, once canopyd knows forks and the
   settings layers, so `resolve.ts` can go.
5. **Remove the plain-git fallback**; the daemon refuses to provision without canopyd and says
   how to install it.
