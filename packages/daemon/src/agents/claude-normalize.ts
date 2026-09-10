import type { TurnImage } from '@canopy/shared'
import { isHarnessText } from '@canopy/shared'

import { imagesFromBlocks } from './images'

/**
 * Text Claude Code writes into the conversation for its own bookkeeping, not the user's words.
 * The tag list lives in @canopy/shared so the UI can apply the same test to logs recorded before
 * the daemon knew a tag (a `<task-notification>` drawn as a user bubble was exactly that gap).
 */
export function isBookkeeping(text: string): boolean {
  return isHarnessText(text)
}

/**
 * A `<system-reminder>` the harness appended *after* the user's own words, inside their block.
 * Dropping the whole block would lose the prompt, so only the trailing segment goes; the
 * lookahead keeps the match to the last reminder, and the loop peels a run of them.
 */
const TRAILING_REMINDER = /\s*<system-reminder>(?:(?!<system-reminder>)[\s\S])*<\/system-reminder>\s*$/

function withoutTrailingReminders(text: string): string {
  let kept = text
  for (let previous = ''; previous !== kept; ) {
    previous = kept
    kept = kept.replace(TRAILING_REMINDER, '')
  }
  return kept
}

interface RawMessage {
  role?: string
  content?: unknown
}

/** One SDK / session-file message, as the mapper wants it: `type` plus the wire fields it reads. */
export interface WireMessage {
  type?: string
  uuid?: string
  session_id?: string
  parent_tool_use_id?: string | null
  isSynthetic?: boolean
  message?: RawMessage
  [key: string]: unknown
}

/**
 * The agent-stream Claude mapper reads a `user` line one of two ways: a **string** `content` is the
 * human's prompt and opens a turn; an **array** `content` is the CLI feeding the model back, and any
 * text in it is forced synthetic (so it never opens a turn). Canopy composes prompts with images,
 * which arrive as array content and would therefore vanish — and Claude Code also injects
 * `<system-reminder>` / `<command-name>` / `<local-command-*>` bookkeeping as ordinary text.
 *
 * So before mapping a `user` line we normalize it: a prompt (no `tool_result` block) has its
 * bookkeeping text dropped, its images lifted out, and its remaining text collapsed to a string so
 * the mapper treats it as the real prompt it is; a bookkeeping-only line is flagged synthetic. A
 * line carrying a `tool_result` is left untouched — that is genuine array content the mapper maps to
 * `tool_call_completed`.
 */
export function normalizeUserMessage(message: WireMessage): { line: WireMessage; images: TurnImage[] } {
  const body = message.message
  if (message.type !== 'user' || !body) return { line: message, images: [] }

  const content = body.content
  if (typeof content === 'string') {
    if (isBookkeeping(content)) return { line: { ...message, isSynthetic: true }, images: [] }
    return { line: message, images: [] }
  }
  if (!Array.isArray(content)) return { line: message, images: [] }

  const blocks = content as Array<{ type?: string; text?: string }>
  // Tool output, not a prompt — the mapper turns each `tool_result` into a completion.
  if (blocks.some((block) => block.type === 'tool_result')) return { line: message, images: [] }

  const kept = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => withoutTrailingReminders(block.text ?? ''))
    .filter((text) => text !== '' && !isBookkeeping(text))
    .join('\n')
    .trim()
  const images = imagesFromBlocks(blocks as Array<{ type: string }>, kept)

  // Nothing the user actually said — drop it by marking it synthetic rather than opening an empty turn.
  if (kept === '' && images.length === 0) return { line: { ...message, isSynthetic: true }, images: [] }

  return { line: { ...message, message: { ...body, content: kept } }, images }
}
