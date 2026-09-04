import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Effort } from '@canopy/shared'

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

/** Claude Code keys its project directories by the cwd with every non-alphanumeric replaced by `-`. */
export const sessionFilePath = (cwd: string, sessionId: string): string =>
  join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)

/**
 * The effort of the most recent assistant turn. Claude Code writes `effort` at the top
 * level of each assistant entry, which the SDK's getSessionMessages drops — so this reads
 * the transcript file itself, from the end.
 */
export function lastAssistantEffort(jsonl: string): Effort | undefined {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.includes('"type":"assistant"')) continue
    try {
      const entry = JSON.parse(line) as { type?: string; effort?: string }
      if (entry.type === 'assistant' && entry.effort && EFFORTS.has(entry.effort)) return entry.effort as Effort
    } catch {
      // partial or foreign line; keep scanning
    }
  }
  return undefined
}

/** A prompt the user typed while a turn was running; Claude Code folds it into that turn. */
export interface QueuedPrompt {
  uuid: string
  /** The transcript entry it was delivered after. */
  parentUuid: string
  /** Plain text, or content blocks when the prompt carried images. */
  prompt: string | unknown[]
}

/**
 * Prompts typed mid-turn never become `user` messages: Claude Code stores them as
 * `queued_command` attachments, which the SDK's getSessionMessages drops. Read them
 * from the file so the conversation shows what the user actually said.
 */
export function queuedPrompts(jsonl: string): QueuedPrompt[] {
  const prompts: QueuedPrompt[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"queued_command"')) continue
    try {
      const entry = JSON.parse(line) as { type?: string; uuid?: string; parentUuid?: string; attachment?: { type?: string; prompt?: string | unknown[] } }
      if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && entry.uuid && entry.parentUuid && entry.attachment.prompt) {
        prompts.push({ uuid: entry.uuid, parentUuid: entry.parentUuid, prompt: entry.attachment.prompt })
      }
    } catch {
      // partial or foreign line; keep scanning
    }
  }
  return prompts
}

/** What the session file records beyond the messages the SDK replays. */
export interface SessionExtras {
  effort?: Effort
  queued: QueuedPrompt[]
}

export async function readSessionExtras(cwd: string | undefined, sessionId: string): Promise<SessionExtras> {
  if (!cwd) return { queued: [] }
  try {
    const jsonl = await readFile(sessionFilePath(cwd, sessionId), 'utf8')
    return { effort: lastAssistantEffort(jsonl), queued: queuedPrompts(jsonl) }
  } catch {
    return { queued: [] }
  }
}
