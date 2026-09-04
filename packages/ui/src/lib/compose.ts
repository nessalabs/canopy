import type { ImageMediaType } from '@canopy/shared'

import type { ChatComposerAttachmentKind } from '@/components/ui/chat-composer'

/** Context the reviewer staged next to their message: a file, pasted text, or a slash command. */
export interface Attachment {
  id: string
  kind: ChatComposerAttachmentKind
  label: string
  /** What the agent receives for this attachment. */
  text: string
  /** Present for pasted images; sent as an image block, referenced in text as `[Image #N]`. */
  image?: { mediaType: ImageMediaType; data: string }
}

export interface SlashCommand {
  id: string
  label: string
  description: string
  /** The prompt inserted when picked. */
  prompt: string
}

/** Canopy's `/` menu: review-oriented prompts the agent gets verbatim. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'summarize', label: 'summarize', description: 'Summarize the changes on this branch', prompt: 'Summarize the changes on this branch in a few bullet points: what changed, why, and anything risky.' },
  { id: 'explain', label: 'explain', description: 'Explain the current diff line by line where it matters', prompt: 'Walk me through the current diff. Focus on the parts a reviewer would question and explain the reasoning behind them.' },
  { id: 'tests', label: 'tests', description: 'Ask which tests cover the change', prompt: 'Which tests cover the changes on this branch? Run them if you can and report what passed, failed, or is missing.' },
  { id: 'risks', label: 'risks', description: 'List regressions this change could cause', prompt: 'List the regressions this change could plausibly cause and how you would verify each one.' }
]

/** Renders one attachment as the agent should read it. */
const RENDER: Record<ChatComposerAttachmentKind, (a: Attachment) => string> = {
  file: (a) => `- File: ${a.text}`,
  mention: (a) => `- File: ${a.text}`,
  'pasted-text': (a) => `- Pasted text:\n\`\`\`\n${a.text}\n\`\`\``,
  skill: (a) => `- ${a.text}`,
  plugin: (a) => `- ${a.text}`
}

/**
 * The single user turn: `[Image #N]` placeholders (the convention Claude Code itself uses,
 * so transcripts label them consistently), the typed message, then a Context section for
 * any non-image attachments.
 */
export function composeMessage(draft: string, attachments: Attachment[]): string {
  const images = attachments.filter((a) => a.image)
  const others = attachments.filter((a) => !a.image)
  const placeholders = images.map((a) => `[${a.label}]`).join(' ')
  const body = [placeholders, draft.trim()].filter(Boolean).join(' ')
  if (others.length === 0) return body
  return [body, 'Context:', others.map((a) => RENDER[a.kind](a)).join('\n')].filter(Boolean).join('\n\n')
}
