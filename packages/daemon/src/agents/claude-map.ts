import type { AgentStreamEvent, TurnImage } from '@canopy/shared'
import type { AgentEvent, ClaudeStreamMapper, ClaudeWireLine } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { newId } from '../lib/ids'
import { normalizeUserMessage, type WireMessage } from './claude-normalize'
import { filesFromEvents } from './files-annotation'

export interface MappedMessage {
  events: AgentEvent[]
  /** Written paths by `callId` for the tool calls in this batch. */
  files: Record<string, string[]>
  /** Images a user turn carried, by the resulting `user_message` event id. */
  extras: Record<string, { images: TurnImage[] }>
}

const nothing = (): MappedMessage => ({ events: [], files: {}, extras: {} })

/** How the session file stores the prompt of a slash command: the name and its arguments, tagged. */
const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/
const COMMAND_ARGS = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/
/** How the session file stores what a local slash command printed. */
const LOCAL_OUTPUT = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/

/**
 * The prompt a slash command was, as the person typed it (`/context`, `/compact focus on tests`),
 * from the tagged form the session file keeps — or null when the line is not one.
 */
export function commandPrompt(content: unknown): string | null {
  if (typeof content !== 'string') return null
  const name = COMMAND_NAME.exec(content)?.[1]
  if (!name) return null
  const args = COMMAND_ARGS.exec(content)?.[1] ?? ''
  return args ? `${name} ${args}` : name
}

/** A synthetic assistant line carrying `text`, for output the CLI drew as the assistant's. */
const assistantLine = (message: WireMessage, text: string): WireMessage => ({
  type: 'assistant',
  uuid: message.uuid ?? newId(),
  session_id: message.session_id,
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] }
})

/**
 * Rewrites the few message kinds agent-stream has no arm for, before the mapper sees them.
 *
 * `local_command_output` is what a local slash command (`/context`, `/usage`) answers with; the CLI
 * draws it as assistant text, so it arrives here as the assistant message it would have been.
 * `commands_changed` and `conversation_reset` are bookkeeping the daemon acts on elsewhere (the
 * capability cache; the UI's own `/clear`) — mapping them would only add an `unknown` event to the
 * transcript, so they map to nothing at all.
 */
function forMapper(message: WireMessage): WireMessage | null {
  if (message.type === 'conversation_reset') return null
  // Replay: the session file keeps a slash command's prompt tagged (`<command-name>`), which the
  // normalizer would otherwise file under bookkeeping and hide. It is what the person typed.
  if (message.type === 'user') {
    const prompt = commandPrompt(message.message?.content)
    return prompt === null ? message : { ...message, message: { ...message.message, content: prompt } }
  }
  if (message.type !== 'system') return message

  switch (message.subtype as string | undefined) {
    // Live: what a local slash command answered with.
    case 'local_command_output':
      return assistantLine(message, String(message.content ?? ''))
    // Replay: the same answer as the session file stores it — tagged output, or a bare echo of the
    // command name (which the `<command-name>` line above already covers).
    case 'local_command': {
      const output = LOCAL_OUTPUT.exec(String(message.content ?? ''))
      return output ? assistantLine(message, output[2] ?? '') : null
    }
    case 'commands_changed':
      return null
    default:
      return message
  }
}

/**
 * Normalizes one SDK / session-file message and maps it to agent-stream events, tagging on the two
 * things agent-stream leaves to the host: which files each tool call wrote, and the images a user
 * turn carried (which the mapper drops from user content). Shared by live turns and replay so both
 * produce the same events from the same message.
 */
export function mapClaudeMessage(mapper: ClaudeStreamMapper, message: WireMessage, cwd?: string): MappedMessage {
  const translated = forMapper(message)
  if (translated === null) return nothing()
  const { line, images } = normalizeUserMessage(translated)
  const events = [...mapper.map(line as unknown as ClaudeWireLine)]
  const files = filesFromEvents(events, cwd)

  const extras: Record<string, { images: TurnImage[] }> = {}
  if (images.length > 0) {
    const prompt = events.find((event) => isEvent(event, AgentEventType.UserMessage))
    if (prompt) extras[prompt.id] = { images }
  }
  return { events, files, extras }
}

/** What one model contributed to a turn, as `result.modelUsage` reports it. */
interface ModelSpend {
  inputTokens?: number
  contextWindow?: number
}

/**
 * What the turn cost, read off the SDK's `result`.
 *
 * `usage` covers the main agent loop only, which is the right basis for "how full is the context
 * window": its input plus both cache figures is what the last call actually carried. The window's
 * *size* is only in `modelUsage`, keyed by model — several models can appear (subagents, compaction),
 * so the main one is taken to be whichever read the most input.
 *
 * Nothing is reported that the CLI did not report: a subscription session prices nothing, and a
 * `costUsd` of 0 there would read as free rather than as unknown.
 */
export function usageFrom(result: {
  total_cost_usd?: number
  duration_ms?: number
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  modelUsage?: Record<string, ModelSpend>
}): Extract<AgentStreamEvent, { type: 'usage' }> | undefined {
  const usage = result.usage
  const context = usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : undefined
  const main = Object.values(result.modelUsage ?? {}).sort((a, b) => (b.inputTokens ?? 0) - (a.inputTokens ?? 0))[0]

  const frame = {
    type: 'usage' as const,
    costUsd: positive(result.total_cost_usd),
    inputTokens: positive(usage?.input_tokens),
    outputTokens: positive(usage?.output_tokens),
    // A local command's result reports zeros; "0 context" would state the window was empty.
    contextTokens: positive(context),
    contextWindow: positive(main?.contextWindow),
    durationMs: result.duration_ms
  }
  const reported = Object.entries(frame).filter(([key, value]) => key !== 'type' && value !== undefined)
  return reported.length > 0 ? (Object.fromEntries([['type', 'usage'], ...reported]) as Extract<AgentStreamEvent, { type: 'usage' }>) : undefined
}

const positive = (value: number | undefined): number | undefined => (typeof value === 'number' && value > 0 ? value : undefined)
