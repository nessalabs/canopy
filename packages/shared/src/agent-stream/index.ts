/**
 * Canopy's barrel over the vendored `@nessa-ui/agent-stream` sources (see VENDORED.md).
 *
 * nessa ships its own barrels (`index.ts`, `contract.ts`, `claude/index.ts`, `codex/index.ts`), but
 * they star-export every provider — acp, cursor, opencode, Codex `exec --json` — which Canopy does
 * not vendor. This file is the only non-vendored module in the directory: it exposes the shared
 * contract, the transcript fold, and the two providers Canopy drives (Claude via the Agent SDK's
 * stream-json frames, Codex via app-server JSON-RPC). Import it as `@canopy/shared/agent-stream`.
 */

// ---------- the contract every provider maps onto ----------
export * from './events'
export * from './json'
export * from './capabilities'
export { EventSink } from './emitter'
export type { MappingEntry, WireKind } from './mapping'

// ---------- the fold: turns, tool groups, delegated runs ----------
export * from './transcript/index'
// Documented as public upstream but not re-exported from transcript/index.ts.
export { RENDERS, collapseRun } from './transcript/fold'

// ---------- Claude Code (stream-json; the Agent SDK yields the same frames as objects) ----------
export { ClaudeStreamMapper, mapClaudeStream } from './claude/stream/mapper'
export { toolKind, toolTitle, toolVerb } from './claude/tools'
export {
  CLAUDE_EVENT_MAPPING,
  claudeMappingFor,
  claudeWireKind,
  type ClaudeMappingEntry,
  type ClaudeWireKind
} from './claude/stream/mapping'
export { sessionCapabilities as claudeSessionCapabilities } from './claude/stream/capabilities'
export * as claudeWire from './claude/stream/wire'
export type { WireLine as ClaudeWireLine } from './claude/stream/wire'

// ---------- Codex app-server (JSON-RPC over stdio) ----------
export { CodexAppServerMapper, mapCodexAppServerStream } from './codex/app-server/mapper'
export { CODEX_APP_SERVER_MAPPING, codexAppServerKind, codexAppServerMappingFor } from './codex/app-server/mapping'
export { codexCapabilities, CODEX_CAPABILITY_METHODS, type CodexCapabilityMethod } from './codex/app-server/capabilities'
export * as codexWire from './codex/app-server/wire'
export type { CodexAppServerFrame } from './codex/app-server/wire'
