import type { TurnImage } from '@canopy/shared'
import type { AgentEvent, ClaudeStreamMapper, ClaudeWireLine } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { normalizeUserMessage, type WireMessage } from './claude-normalize'
import { filesFromEvents } from './files-annotation'

export interface MappedMessage {
  events: AgentEvent[]
  /** Written paths by `callId` for the tool calls in this batch. */
  files: Record<string, string[]>
  /** Images a user turn carried, by the resulting `user_message` event id. */
  extras: Record<string, { images: TurnImage[] }>
}

/**
 * Normalizes one SDK / session-file message and maps it to agent-stream events, tagging on the two
 * things agent-stream leaves to the host: which files each tool call wrote, and the images a user
 * turn carried (which the mapper drops from user content). Shared by live turns and replay so both
 * produce the same events from the same message.
 */
export function mapClaudeMessage(mapper: ClaudeStreamMapper, message: WireMessage, cwd?: string): MappedMessage {
  const { line, images } = normalizeUserMessage(message)
  const events = [...mapper.map(line as unknown as ClaudeWireLine)]
  const files = filesFromEvents(events, cwd)

  const extras: Record<string, { images: TurnImage[] }> = {}
  if (images.length > 0) {
    const prompt = events.find((event) => isEvent(event, AgentEventType.UserMessage))
    if (prompt) extras[prompt.id] = { images }
  }
  return { events, files, extras }
}
