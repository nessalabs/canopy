# Canopy — deferred work

Things the current iteration deliberately leaves for later. Keep this list honest: when an
item lands, delete it here.

## nessa-ui vendoring → package import

- `packages/ui/src/components/ui/**`, `components/composites/app-shell/**`,
  `components/split-view/**` and `lib/app-shell-layout/**` are **vendored copies** of nessa_ui
  components installed with `npm run ui:add -- <name>` (local-first from `../nessa_ui`).
  They must be replaced by `import … from '@nessa-ui/react'` once that package is published.
  As of 2026-09-01 `npm view @nessa-ui/react` is a 404 and `https://nessalabs.ai/r/*.json`
  (the registry URL the nessa docs advertise) also 404s; only the GitHub registry
  (`nessalabs/nessa_ui/<name>`) and the local checkout work.
- Never edit vendored files by hand. Two known wrinkles are handled in `scripts/ui-add.mjs`:
  - shadcn rewrites `@/components/split-view` (a directory index) to
    `@/components/split-view/split-view`, which lacks the panel/separator exports —
    `IMPORT_FIXUPS` undoes it after every install.
  - vendored code is not written for `noUncheckedIndexedAccess` / `noUnusedLocals`, so those
    flags are off in `packages/ui/tsconfig.json` and the app tsconfigs that include it.
- `message-markdown` pulls `mermaid` (static import, ~700 kB) and Shiki grammars through
  `code-block`; the web bundle is ~2.3 MB minified. Code-split or lazy-load once the
  package import exists (or ask nessa_ui for a dynamic `import('mermaid')`).
- `file-icon` (editor-style file/folder glyphs) was added to the local nessa_ui checkout on
  2026-09-02 (component, story, registry entry, index export) and vendored from there; it is not
  committed or pushed upstream yet.
- Components on the local `feat/canopy-dashboard-primitives` branch but not on `main`
  (dialog, select, tooltip, scroll-area, switch, textarea, accordion, status-dot, diff-view,
  framed-box, …) can only be re-vendored from the checkout until PR #48 merges.

## Agent tab

- Images ride inline as base64 in transcript JSON (simple, works with bearer auth). A session
  with many screenshots makes that payload heavy; move to a per-image route once needed.

- `components/agent/provider-icon.tsx` inlines the Claude/OpenAI marks from nessa_ui's storybook
  `model-icons` assets; nessa_ui has no provider-icon component yet — upstream one and re-vendor.

- `thinking-orbs` (third-party npm, MIT) renders the thinking/working/solving indicator via
  `components/agent/activity-orb.tsx` — the one non-nessa visual in the app, added at the
  user's request. If it sticks, wrap it as a nessa_ui `thinking-orb` component upstream.

- Per-turn changes (`TurnChanges`, hover action on a user turn / composer button) list the files
  a turn wrote and show their *current* uncommitted diff — not the exact state after that turn.
  Sources, all from the transcript (`TranscriptItem.files`): Claude Edit/Write/MultiEdit/
  NotebookEdit inputs, Codex `fileChange` items, and `agents/shell-writes.ts`, which parses
  Bash/`commandExecution` text for write targets (redirections, tee/sed -i/cp/mv/rm, `cd` and
  `VAR=` tracking, heredoc + `-c` scripts' `open(p,'w')`/`writeFileSync`). Misses: paths built
  at runtime (`$(…)`, loops, `~`), writes by programs (`npm install`, formatters, `git checkout`),
  and anything outside the worktree (dropped). Exact before/after content per turn is the
  hook-based capture in `agents/edit-diffs/` (`docs/plans/agent-turn-snapshots.md`); turns
  without hook rows fall back to this list.
- Edit snapshots: Codex has no tool hooks, so its turns only get the transcript fallback. The
  daemon sees `item/started`/`item/completed` for turns it runs through the app-server — take the
  same Pre/Post snapshots there. Snapshot refs (`refs/canopy/snapshots/*`) are never pruned yet;
  prune with the worktree and by session age. Comments left on a `trees` diff are stored like
  working-tree comments (no spec key), so their line may not match once the file moves on.
- Adopt nessa `agent-stream` (`buildTranscript`, tool groups, delegated runs, plan) once the
  daemon forwards raw provider events (Claude `stream-json`, Codex JSON-RPC) instead of the
  normalized `TranscriptItem`s the ported adapters emit today.
- Per-turn `model` / `effort` reach Claude via the SDK; the Codex adapter ignores them (its
  app-server `turn/start` takes a model too — wire it when Codex turns are verified end to end).
- Codex: `available()` is true whenever the binary exists; stale credentials surface as a
  401 `error` event mid-stream. Run `codex login` to refresh. One shared `codex app-server`
  child per daemon — fine single-user, wrong multi-tenant.
- Attribution is by session `cwd`, ranked by recency. Canopy should record which session it
  launched for which task once it launches agents itself.
- A running session may reject a resume or rejoin mid-turn; `codex queue` is the better verb
  while the agent is still working.

- nessa `mermaid-diagram` swallows parse errors and falls back to the raw source with no
  message (seen 2026-09-02: an agent-written diagram with a stray `)` on one line). Upstream
  an "unparseable diagram" note in the fallback so readers know it is the source, not us.

## Git Diff / explorer

- `DiffExplorer` split sizes are not persisted; wire `SplitView.onLayoutCommit` → localStorage
  once layouts settle. Same for the right-hand side panel width in `app-layout.tsx`.
- The Files side panel reads text only (`CodeBlock`). Images/PDF/CSV could go through nessa
  `file-preview` (needs a Blob, since its fetcher has no bearer token) — vendor when wanted.
- Side panel is the dock for future tools (terminal, browser): add a row to `SIDE_PANELS`.
- Agent tab on phones (`useIsMobile`) shows one panel at a time behind a segmented control; the
  Git Diff tab has no phone layout yet.
- E2E harness: the window manager tiles Electron windows, so viewport sizes are emulated with
  CDP `Emulation.setDeviceMetricsOverride` after the first load (before it, Electron segfaults);
  `Page.captureScreenshot` times out under emulation except right after a popover opens, so
  phone layouts are verified by DOM probes rather than pixels.
- `DiffExplorer` picks its arrangement from its own width (side ≥ 680px, stacked ≥ 480px, else a
  popover tree); tune the breakpoints once real usage settles. Tree rows in a very narrow pane
  still lose their label to the stat/status meta.
- Perf probe with a 5 000-file change set and a 200 k-line file is still to be run against a
  real fixture (unit-level: TreeView story asserts <60 DOM rows for 10 000 nodes; file reads cap
  at 2 MiB, patches at 512 KiB).
- E2E harness note: hidden Electron windows stop compositing after the first frame, so capture
  with `win.setOpacity(0); win.showInactive()` and CDP `Page.captureScreenshot`; a hash-only
  `loadURL` does not reload the app, so seed `localStorage` then load with a fresh query string.

## Real-time and status

- Worktree status is derived from git on each read and polled every 5 s by the UI. Replace
  with the WebSocket `workspaces` topic (seq-resume) from the solution plan once services exist.
- `GET /worktrees` runs ~4 git commands per worktree per poll; add a short in-memory memo in
  `worktrees/service.ts` if it gets noisy with many worktrees.

## Not built yet (tabs show "Coming soon")

- Environment tab: canopy.yaml services, ports, DB forks, logs, env vars (plan M3–M5).
- Resources tab and the Command Center usage panel: per-service CPU/mem.
- Project settings beyond General + Danger zone (worktrunk, provisioning, defaults, cleanup).
- Worktree create: no `.env`, copied files, deps, or DB source options yet; branch deletion
  on destroy is not offered.

## Desktop

- Electron does not start `canopyd` itself; `./dev.sh` runs both. Spawn/adopt the daemon from
  the main process, keep tokens in `safeStorage`, add tray + notifications (plan M8).
- Packaged builds untested (`electron-builder` config moved intact to `apps/desktop`).

## Daemon

- No `canopy` CLI yet (plan M6). `packages/daemon/bin/canopyd.mjs` runs the TS source via tsx;
  add a tsup build for a real binary.
- better-sqlite3 loads a prebuilt binding under Node 25 today; pin Node 22 (`.node-version`)
  if a future Node lacks prebuilds.
