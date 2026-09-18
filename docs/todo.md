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
  - vendored code is not written for `noUncheckedIndexedAccess` / `noUnusedLocals` /
    `noImplicitReturns` (electron-toolkit's base turns the last one on), so those flags are off in
    `packages/ui/tsconfig.json` and the app tsconfigs that include it.
- `components/ui/mermaid-diagram.tsx` carries local edits that are **not upstream** and will be
  lost by the next `ui:add -- mermaid-diagram`: the toolbar clears `--nessa-title-bar-inset`, the
  viewer takes an `inline` shape that fills the nearest `[data-diagram-surface]` ancestor instead
  of the window (Canopy marks its file panes, so a diagram expands inside its pane and the doc
  stays readable beside it), `defaultExpanded` opens the viewer on mount for the diagram window,
  and `DiagramWindowProvider` supplies the "open in a new window" control. Upstream all four to
  nessa_ui and re-vendor.
- `message-markdown` pulls `mermaid` (static import, ~700 kB) and Shiki grammars through
  `code-block`; the web bundle is ~2.3 MB minified. Code-split or lazy-load once the
  package import exists (or ask nessa_ui for a dynamic `import('mermaid')`).
- `file-icon` (editor-style file/folder glyphs) was added to the local nessa_ui checkout on
  2026-09-02 (component, story, registry entry, index export) and vendored from there; it is not
  committed or pushed upstream yet.
- Components on the local `feat/canopy-dashboard-primitives` branch but not on `main`
  (dialog, select, tooltip, scroll-area, switch, textarea, accordion, status-dot, diff-view,
  framed-box, …) can only be re-vendored from the checkout until PR #48 merges.
- `packages/shared/src/agent-stream/**` is a **vendored, trimmed copy** of nessa's `agent-stream`
  registry item (`@nessa-ui/agent-stream`, unpublished as of 2026-09-04), installed with
  `npm run vendor:agent-stream` (not `ui:add`: it is pure TS the daemon needs too, so it lives in
  `@canopy/shared` and is imported as `@canopy/shared/agent-stream`). Only the core, the transcript
  fold, Claude stream-json and Codex app-server are copied; acp/cursor/opencode/`codex exec` are not,
  so nessa's own barrels are dropped and `index.ts` there is Canopy's. `VENDORED.md` records the
  nessa commit. Replace with the npm package once it is published.

## Agent tab

- The transcript is a conversation: the agent's work between two messages collapses into one
  nessa `AgentActivity` cue ("Explored 3 files, 2 searches") and a `Sheet` opens that beat's
  thinking and `ToolCall` rows; delegated runs are `AgentActivityCard`s. The grouping is
  `lib/turn-beats.ts` over `lib/turn-rows.ts`. Cue labels are Canopy's own wording (nessa's
  `formatAgentActivitySummary` has no running tense) — upstream a `running` flag and re-use it.
- Claude Code parity (2026-09-10): every turn runs in the SDK's streaming-input mode so the
  daemon can `interrupt()`, queue a prompt into the running turn and switch model / access mode
  mid-turn (`agents/claude-live.ts`); the `/` menu, `@agent-<name>` mentions, model catalog,
  session sheet (skills, subagents, MCP status, hooks, plugins) come from
  `GET …/agent/capabilities` (`agents/claude-capabilities.ts`: an idle-query probe per checkout,
  cached, plus whatever the last live turn's `init` advertised). Which built-ins work headless is
  recorded in `docs/plans/agent-claude-features.md`; `lib/compose.ts` hides the rest.
  Not done: `effort` cannot change mid-turn (the SDK has no control for it), `/loop` and
  `/fast` have no headless equivalent, file-checkpoint rewind (`rewindFiles`) is not surfaced —
  Canopy's own per-turn snapshots cover that ground.
- Tool permissions: for `edit`/`read-only` autonomy the daemon routes the SDK's `canUseTool` ask to
  the UI as a `permission_requested` event and a nessa `ToolApproval` card answers it through
  `POST …/permissions`. Codex approvals are still auto-answered by autonomy (see Codex below).
  There is no "always allow" yet (the SDK's `updatedPermissions` rules are not surfaced).
- Newly vendored for this: `sheet`, `tool-approval` (+ `json-tree`), `transcript-divider`
  (`lib/overlay-panel.ts` came with the sheet).
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
- Codex turns run through agent-stream's app-server mapper but Codex is not installed here, so the
  live path and `thread/read` replay shapes are covered only by fixture tests — verify end to end
  against a real `codex app-server` (0.144.1+). Codex approvals also emit no `permission_requested`;
  the daemon still auto-answers them, but a real approval UI would need the ACP transport.
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

- Markdown previews resolve links themselves (`doc-links.ts`): a relative link opens that file
  in the pane, a `#fragment` scrolls to the heading whose slugged text matches. Relative *images*
  are still broken — `<img src="./diagram.png">` needs a blob URL from `fileContents`, which only
  returns text today.
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

## Environment & resources (landed 2026-09-09 — see docs/plans/environment-and-resources.md)

- Daemon restart is kill-and-respawn: recorded pids/containers are reaped by start time, then
  worktrees desired `running` start again. PID adoption (keeping a dev server alive across a
  daemon restart) is the planned hardening step.
- `docker` runtime publishes the same port number on both sides and services must bind
  `0.0.0.0` inside the container; host↔container service-to-service calls use `localhost:<port>`.
  A per-runtime URL resolver (container DNS names on the `canopy` network) is not implemented.
- Postgres forks need zero connections on the template: `ensureSource` terminates them before
  `CREATE DATABASE … TEMPLATE`. A `dedicated: true` per-worktree container is the escape hatch.
- MySQL has no TEMPLATE: forks load the seed SQL into a fresh container — slow for big seeds.
- Resource sampling attributes by process group (`ps -o pgid`); double-forking dev servers that
  leave the group are missed. `doctor --gc` for orphan processes/containers is not built.
- Log files rotate at 50 MB per stream; reads across the rotation boundary serve the current
  file only.
- Events are SSE over fetch (bearer header); the daemon keeps a 2 000-event ring for resume.
  Multiple browser tabs each hold one connection.
- The `canopy` hook CLI needs to be on PATH for `.config/wt.toml` hooks (`npm link` in
  `packages/daemon`, or point the hook at `node …/bin/canopy.mjs`); `HostInfo.canopyCommand`
  says what to use.
- Compose runtime: the whole stack is one supervised process (`docker compose up` in the
  foreground); per-container health of compose services is not surfaced individually.
- `sharedStores` only sets `UV_LINK_MODE=hardlink` and `npm_config_prefer_offline`; a
  Canopy-managed cache root for other tools is not built.
- Auto-fetch of the base branch (`autoFetch` / interval settings) is stored but not scheduled yet.
- Stale-worktree notifications (`cleanup.staleGc`) are stored but not surfaced yet.

## Desktop

- Electron does not start `canopyd` itself; `./dev.sh` runs both. Spawn/adopt the daemon from
  the main process and keep tokens in `safeStorage` (plan M8). Until then the menu-bar panel
  shows "canopyd is not running" and reconnects on its own once it comes up.
- Notifications (plan M8) are not wired: a service that dies or an environment that goes
  degraded only shows in the menu-bar icon's count, which gains a `!`. The tray already holds
  the events an `on('failed')` notification would need — see `src/main/tray/state.ts`.
- The menu bar is macOS-shaped: a template icon plus a vibrancy popover. `installTray` runs on
  every platform, but the icon and the panel chrome have only been designed for macOS.
- The panel never destroys anything (no destroy worktree, no database reset) — those need room
  to confirm, which is the app window's job.
- Packaged builds untested (`electron-builder` config moved intact to `apps/desktop`).

## Daemon

- No `canopy` CLI yet (plan M6). `packages/daemon/bin/canopy-daemon.mjs` runs the TS source via tsx;
  add a tsup build for a real binary.
- better-sqlite3 loads a prebuilt binding under Node 25 today; pin Node 22 (`.node-version`)
  if a future Node lacks prebuilds.

## Dependencies

- Root `package.json` overrides `esbuild` to `^0.28.2` so the whole tree shares one esbuild
  (vite 7 and tsx 4 want 0.28, electron-vite 5.0.0 still pins `^0.25.11`). Without it npm nests a
  second esbuild under `tsx/` and npm 11 drops its platform binaries from the lockfile
  (npm/cli#4828), so `tsx watch` fails on any machine that did not generate the lockfile.
  Drop the override once electron-vite depends on esbuild 0.28+.
- `@pierre/diffs` is pinned to 1.3.6 (root `dependencies` and `packages/ui`): 1.4.0 made
  `FileDiffOptions` take a second type argument, which breaks the vendored `diff-view.tsx`. It sits
  in the root `dependencies` on purpose — declared only in `packages/ui`, npm's workspace resolver
  nested it under `packages/ui/node_modules` without its own dependency subtree (shiki, diff,
  lru_map, …), so the renderer bundle failed to resolve them; hoisting it to the root installs the
  full tree. Bump it together with a fix in `diff-view.tsx`, and it can move back to `packages/ui`
  alone once the nesting bug is gone.
