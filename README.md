# Canopy

Work on several branches at once, each in its own git worktree with its own running
environment: its own ports, its own dependencies, its own dev server, its own database forks,
described by one `canopy.yaml`. The repository has two halves:

- **`daemon/`** is the engine: the `canopy-worktree` Rust crate and its `canopywt` binary.
  It creates and removes worktrees, carries gitignored files across, allocates ports, resolves
  the environment, runs setup steps and supervises services, keeping no state beyond what git
  cannot know. Every command takes `--json`, so it works the same from a terminal, CI or an agent.
- **Everything else is the client**: `canopyd`, the Node service that drives `canopywt`, keeps
  project and worktree state, runs agent sessions and serves REST + SSE; the shared contracts;
  and the Electron desktop app and web dashboard that talk to `canopyd`.

## Layout

```
daemon/           canopy-worktree crate → `canopywt` (Rust). Its own README, docs/cli.md,
                  docs/configuration.md, docs/json-api.md (the contract canopyd relies on), docs/design.md
packages/shared   @canopy/shared — zod schemas + DTOs, route table, typed client, SSE reader
packages/daemon   @canopy/daemon — canopyd (Fastify · better-sqlite3 · execa · agent adapters);
                  shells out to `canopywt` (src/env/worktree/), plain git when it is not installed
packages/ui       @canopy/ui     — <CanopyApp/>, screens, vendored nessa-ui (see docs/todo.md)
apps/desktop      Electron shell (electron-vite); reads ~/.canopy/token and connects directly,
                  plus the macOS menu-bar panel (src/main/tray, src/renderer/src/tray)
apps/web          Vite shell; `npm run build:web` output is served by canopyd at /
```

## Run

```bash
./dev.sh setup      # npm install (workspaces), electron binary, canopywt (cargo install), typecheck
./dev.sh            # canopyd + Electron
./dev.sh web        # canopyd + web client on http://localhost:5173 (paste URL + token)
./dev.sh daemon     # canopyd only — prints nothing secret; token is in ~/.canopy/token
./dev.sh canopywt   # rebuild + reinstall canopywt from daemon/ after changing the crate
./dev.sh test       # vitest across workspaces
cd daemon && cargo test && cargo clippy --all-targets -- -D warnings   # the crate
```

`.github/workflows/daemon.yml` runs the crate's fmt, clippy, tests and doctests on Linux and
macOS whenever `daemon/` changes.

## Environments

Any repo with a `canopy.yaml` runs each worktree in isolation: own ports, own database forks
(Postgres · MySQL · SQLite · Redis), own processes or containers (host · Docker · Compose), and a
generated `.env.canopy`. `docs/plans/environment-and-resources.md` is the design;
`daemon/docs/configuration.md` is the reference for every key, and
`packages/shared/src/canopy-yaml.ts` is the client-side schema (also the live linter in project
settings, which can scaffold a starter file). Creating a worktree, copying files, allocating
ports and running setup steps go through `canopywt` when it is on PATH, with plain `git worktree`
as the fallback; the tool prints one JSON envelope per command and its error codes are stable, so
canopyd maps them straight through. `packages/daemon/bin/canopy.mjs` is the
`canopy provision|teardown|forget|start|stop|status` command that git hooks call
(`canopywt hook install` puts the `post-checkout` in place) so a worktree created from a terminal
is provisioned too (`npm link` in `packages/daemon` puts it on PATH).

Canopy runs itself the same way: the repo's own `canopy.yaml` gives every worktree a private
daemon (`CANOPY_HOME` inside the checkout, the main repo registered as a project) and a web
client on their own ports, so a branch can be started from the worktree's Environment tab and
opened in a separate window, already signed in, without touching the daemon that manages it.

## Committing

The Changes tab commits: a checkbox per changed file, per-hunk checkboxes under a file's **Hunks**
view, a summary and description, and `Commit to <branch>`. The checkbox *is* git's index — ticking
one runs `git add`, clearing it runs `git reset`, and committing is a plain `git commit` — so a
`git add -p` you did in a terminal shows up as an already-ticked (or mixed) box instead of being
thrown away, and a file you left unticked cannot end up in the commit. Click, ⌘/Ctrl-click,
shift-click and press-drag select several rows at once; a checkbox or menu action on a row inside
the selection applies to all of it.

Right-click a file or folder for the four ways to keep it out of commits: **Ignore locally**
(`.git/info/exclude` — never committed, so `.gitignore` stays clean), **Add to `.gitignore`**,
**Ignore my local edits** (`--skip-worktree`, this worktree only) and **Stop tracking**
(`git rm --cached`, which stages a deletion). The first three leave no trace in `git status`, so a
"N paths hidden" chip under the file list lists them and puts them back.

**Exact per-turn diffs** in the Agent tab need Claude Code hooks that tell canopyd when a tool call
starts and ends: `npm run hooks:setup -- --write` adds them to `~/.claude/settings.json` (asks first).
Without them the tab falls back to the files each turn's tool calls named.

State lives in `~/.canopy` (`state.db`, `token`, `config.json`, `worktrees/`, `worktrees-data/`
for logs and file-backed DB forks); `CANOPY_HOME` and `CANOPY_PORT` override. Requires Node ≥ 22,
git, and a Rust toolchain (≥ 1.90) to build `canopywt`; optional: `docker` (Docker/Compose
runtimes, Postgres/MySQL/Redis forks) and the `claude` / `codex` CLIs.

## Menu bar (macOS)

The desktop app installs a menu-bar extra: the icon carries the number of running environments
(with a `!` when one needs attention), and clicking it opens a popover listing every project's
worktrees with their state, the ports their services are listening on — click one to open it in
the browser — and start/stop/restart, open-in-editor and open-in-terminal. The header totals what
Canopy's own supervised processes cost in CPU and memory, not what the machine is doing. The main process holds
the daemon connection (`apps/desktop/src/main/tray/state.ts`), so the icon stays right whether or
not a window is open, and it reconnects on its own when canopyd restarts. The glyph is generated
by `node scripts/make-tray-icon.mjs`.

## nessa-ui

Every visual primitive comes from [nessa_ui](https://github.com/nessalabs/nessa_ui). `@nessa-ui/react`
is not on npm yet, so components are vendored into `packages/ui/src/components` with

```bash
npm run ui:add -- tool-call badge --no-build   # local-first from ../nessa_ui, else GitHub main
```

Do not edit vendored files; re-vendor. `docs/todo.md` tracks the switch to package imports.
