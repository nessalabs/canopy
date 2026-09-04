import type { AgentEvent } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { claudeWrittenFiles } from './edit-diffs/written-files'

/**
 * Files each `tool_call_started` in a mapped batch wrote, by `callId`; empty entries omitted.
 *
 * agent-stream carries the tool call but not this: nessa's Claude mapper deliberately emits no
 * `file_edits` (a consumer derives it from the file-writing tools). Resolving a shell command's
 * relative write targets needs the session's `cwd`, so it stays daemon-side next to
 * `shellWriteTargets` rather than shipping the tokenizer to the browser.
 */
export function filesFromEvents(events: readonly AgentEvent[], cwd?: string): Record<string, string[]> {
  const files: Record<string, string[]> = {}
  for (const event of events) {
    if (!isEvent(event, AgentEventType.ToolCallStarted)) continue
    const written = claudeWrittenFiles(event.payload.name, event.payload.input, cwd)
    if (written.length > 0) files[event.payload.callId] = written
  }
  return files
}
