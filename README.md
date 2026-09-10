# Canopy

A development-environment manager for git worktrees: a `canopyd` daemon owns the state, and
thin clients (Electron desktop app, web dashboard) talk to it over REST + SSE.

## Layout

```
packages/shared   @canopy/shared — zod schemas + DTOs, route table, typed client, SSE reader
packages/daemon   @canopy/daemon — canopyd (Fastify · better-sqlite3 · execa · agent adapters)
packages/ui       @canopy/ui     — <CanopyApp/>, screens, vendored nessa-ui (see docs/todo.md)
apps/desktop      Electron shell (electron-vite); reads ~/.canopy/token and connects directly,
                  plus the macOS menu-bar panel (src/main/tray, src/renderer/src/tray)
apps/web          Vite shell; `npm run build:web` output is served by canopyd at /
```

## Run

```bash
./dev.sh setup      # npm install (workspaces), electron binary, typecheck
./dev.sh            # daemon + Electron
./dev.sh web        # daemon + web client on http://localhost:5173 (paste URL + token)
./dev.sh daemon     # daemon only — prints nothing secret; token is in ~/.canopy/token
./dev.sh test       # vitest across workspaces
```

## Environments

Any repo with a `canopy.yaml` runs each worktree in isolation: own ports, own database forks
(Postgres · MySQL · SQLite · Redis), own processes or containers (host · Docker · Compose), and a
generated `.env.canopy`. `docs/plans/environment-and-resources.md` is the design;
`packages/shared/src/canopy-yaml.ts` is the schema (also the live linter in project settings,
which can scaffold a starter file). Worktrees are created through
[worktrunk](https://worktrunk.dev) (`wt`) when it is installed, with plain `git worktree` as the
fallback; `packages/daemon/bin/canopy.mjs` is the `canopy provision|teardown|forget|start|stop|status`
command that worktrunk hooks call so a `wt switch --create` from a terminal is provisioned too
(`npm link` in `packages/daemon` puts it on PATH).

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
for logs and file-backed DB forks); `CANOPY_HOME` and `CANOPY_PORT` override. Requires Node ≥ 22
and git; optional: `wt` (worktrunk), `docker` (Docker/Compose runtimes, Postgres/MySQL/Redis
forks), and the `claude` / `codex` CLIs.

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
