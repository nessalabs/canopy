# Agent tab: full Claude Code support

Goal: everything a terminal Claude Code session offers — slash commands, skills, subagents,
hooks, MCP servers, model/effort/access switching, interrupt, typing while it works, usage —
reachable from the Agent tab, through the Agent SDK the daemon already drives. Server-first
(see the remote-hosting direction): the daemon owns every capability read and every control;
the UI is a client of `@canopy/shared`'s contract.

## What the SDK gives us (verified against 0.3.260 on 2026-09-10)

- `query({ prompt: <async generator> })` — streaming-input mode. Required for every control
  request below. The generator yields `{ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }`.
- `query.initializationResult()` — resolves once the CLI is up, **without sending a prompt**
  (~0.7 s warm, ~4 s cold): `{ commands: SlashCommand[], agents: AgentInfo[], models: ModelInfo[],
  output_style, available_output_styles, account: { email, organization, subscriptionType } }`.
  `SlashCommand = { name, description, argumentHint, aliases? }`. Skills and user commands carry
  a `(user)` / `(project)` suffix in `description`; plugin commands are `plugin:name`.
- `system/init` message (every turn): `slash_commands`, `terminal_slash_commands`, `skills`,
  `agents`, `tools`, `mcp_servers[{name,status}]`, `plugins`, `model`, `permissionMode`,
  `output_style`, `claude_code_version`, `capabilities`.
- `system/commands_changed` — replace the cached command list.
- `query.supportedModels()` / `supportedAgents()` / `mcpServerStatus()` / `accountInfo()`.
- `query.interrupt()` — clean stop; the turn still emits its `result`.
- `query.setModel(id)` / `setPermissionMode(mode)` — mid-turn.
- `resolveSettings({ cwd })` — merged settings + provenance; `effective.hooks` is
  `{ [event]: [{ matcher?, hooks: [{ type, command?, url?, … }] }] }`.
- Slash commands **are** processed when sent as the user message: `/context`, `/cost`,
  `/usage` come back as an `assistant` message + `result` (num_turns 0, no cost); custom
  commands and skills expand into the prompt; `/help` answers "not available". Nothing
  extra to do beyond sending the text.
- `@agent-<name>` in a prompt addresses that subagent (the CLI's own mention syntax).
- `AskUserQuestion` arrives through `canUseTool` with `input.questions[]`
  (`{ question, header, options[{label, description}], multiSelect }`); answer with
  `{ behavior: 'allow', updatedInput: { ...input, answers: { [question]: 'label' | 'label, label' } } }`.
- `result` carries `total_cost_usd`, `usage`, `modelUsage[model].contextWindow`, `duration_ms`.

## Contract (`@canopy/shared`, done)

- `AgentCapabilities` — `GET /worktrees/:id/agent/capabilities?provider=claude[&session=<sid>][&refresh=1]`.
- `POST /agent/sessions/:provider/:sid/interrupt` — 204, or 404 `no_live_turn`.
- `POST /agent/sessions/:provider/:sid/queue` — `QueueMessageInput`; 204 / 404 `no_live_turn`.
- `PATCH /agent/sessions/:provider/:sid/controls` — `LiveControlsInput`; 204 / 404 `no_live_turn`.
- Stream frame `usage` after the result: cost, tokens, context size, duration.

## Daemon

- `agents/claude.ts` — every turn runs in streaming-input mode. A `LiveTurn` (new
  `agents/claude-live.ts`) is registered by session id while the SSE stream is open:
  `{ push(message), interrupt(), setModel(), setPermissionMode() }`. A fresh session
  re-keys once `init` names it. Stop = `interrupt()` (SSE close still aborts).
- `agents/claude-capabilities.ts` — lazy idle-query probe per cwd (cache with TTL,
  `refresh` bypasses; `commands_changed` from a live turn invalidates; a live turn's `init`
  refreshes the lists it carries). Hooks from `resolveSettings`. Never runs at boot.
- `claude-map.ts` — `system/local_command_output` → assistant text; `conversation_reset` and
  `commands_changed` handled; `result` → `usage` frame.
- Routes + `AgentAdapter` optional methods: `capabilities`, `interrupt`, `queue`, `control`.

## UI

- Composer `/` menu lists the real commands, grouped (Commands · Skills · Custom · Plugins ·
  Canopy prompts); picking inserts `/name ` (+ hint). `/clear` (and aliases) starts a new
  session client-side; everything else is sent verbatim.
- Composer `@` menu: changed files **and** subagents (`@agent-<name>`).
- While a turn runs the composer stays live: Send queues into the turn; Stop interrupts.
- Model picker and effort levels come from capabilities (fallback: today's list).
- Session details sheet: account, version, output style, model, mode, tools, skills,
  subagents, MCP servers (status), plugins, hooks, commands.
- `AskUserQuestion` renders as a questionnaire card, not a JSON approval.
- Usage line after a turn (cost · context).

## Built-in commands, measured (2026-09-10, SDK 0.3.260, one fresh session each)

Answer locally, no model call — kept in the menu: `/advisor`, `/autocompact`, `/config key=value`,
`/context`, `/effort <level>`, `/mcp` (summary only), `/model <name>`, `/reload-plugins`,
`/reload-skills`, `/rename`, `/usage` (= `/cost`, `/stats`), `/skill-doctor`, `/goal`, `/recap`,
`/compact`, `/agents` (prints that the wizard was removed — hidden), `/clear` (emits
`conversation_reset`; Canopy starts a new session client-side instead).

Run a model turn — kept: `/init`, `/insights` (cost ≈ $2, writes an HTML report under
`~/.claude/usage-data`), `/doctor` (> 90 s), `/schedule`, `/batch`, `/ultrareview`, and every
skill / custom command (`/ping` from `.claude/commands/ping.md` answered "PONG").

Hidden from the menu, with the reason: `/help` and `/fast` answer "not available in this
environment / the Agent SDK"; `/usage-credits` and `/extra-usage` open a browser on the daemon's
host; `/import`, `/auto-mode-setup`, `/design*`, `/list-agents`, `/team-onboarding` are wizards or
terminal peering; `/loop` lives in the CLI process, which ends with the turn; `/color` and
`/heapdump` (writes a heap snapshot to the Desktop) are terminal housekeeping.

Replay caveat: a local command's answer is stored as a `system/local_command` row that the SDK's
`getSessionMessages` drops, and its prompt as a `<command-name>` line — the daemon reads the
former from the session file and unwraps the latter (`claude-session.ts`, `claude-map.ts`).
