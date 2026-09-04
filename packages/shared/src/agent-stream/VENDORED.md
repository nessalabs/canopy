# Vendored: @nessa-ui/agent-stream

Source: nessalabs/nessa_ui `main` @ `3cfcefb66ddf14e564cc596455d15424ce03dff1` (registry item `agent-stream`, `packages/agent-stream/src`).
Vendored on 2026-09-04 with `node scripts/vendor-agent-stream.mjs`.

Do not edit these files by hand. Re-run the script; Canopy-specific glue lives in `index.ts` (the
barrel, not vendored) and in the daemon/UI code that consumes it.

Kept (Claude stream-json + Codex app-server + core + transcript fold); acp, cursor, opencode and
Codex `exec --json` are not copied, nor are nessa's own barrels that reference them.

- capabilities.ts
- claude/stream/capabilities.ts
- claude/stream/mapper.ts
- claude/stream/mapping.ts
- claude/stream/wire.ts
- claude/tools.ts
- codex/app-server/capabilities.ts
- codex/app-server/mapper.ts
- codex/app-server/mapping.ts
- codex/app-server/wire.ts
- emitter.ts
- events.ts
- json.ts
- mapping.ts
- transcript/builder.ts
- transcript/fold.ts
- transcript/index.ts
