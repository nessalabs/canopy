# Canopy

A development-environment manager for git worktrees: a `canopyd` daemon owns the state, and
thin clients (Electron desktop app, web dashboard) talk to it over REST + SSE.

## Layout

```
packages/shared   @canopy/shared — zod schemas + DTOs, route table, typed client, SSE reader
packages/daemon   @canopy/daemon — canopyd (Fastify · better-sqlite3 · execa · agent adapters)
packages/ui       @canopy/ui     — <CanopyApp/>, screens, vendored nessa-ui (see docs/todo.md)
apps/desktop      Electron shell (electron-vite); reads ~/.canopy/token and connects directly
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

**Exact per-turn diffs** in the Agent tab need Claude Code hooks that tell canopyd when a tool call
starts and ends: `npm run hooks:setup -- --write` adds them to `~/.claude/settings.json` (asks first).
Without them the tab falls back to the files each turn's tool calls named.

State lives in `~/.canopy` (`state.db`, `token`, `config.json`, `worktrees/`); `CANOPY_HOME`
and `CANOPY_PORT` override. Requires Node ≥ 22, git, and optionally the `claude` / `codex` CLIs.

## nessa-ui

Every visual primitive comes from [nessa_ui](https://github.com/nessalabs/nessa_ui). `@nessa-ui/react`
is not on npm yet, so components are vendored into `packages/ui/src/components` with

```bash
npm run ui:add -- tool-call badge --no-build   # local-first from ../nessa_ui, else GitHub main
```

Do not edit vendored files; re-vendor. `docs/todo.md` tracks the switch to package imports.
