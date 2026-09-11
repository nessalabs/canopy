import type { AgentCommand, AgentSubagent, ImageMediaType } from '@canopy/shared'

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

/** The `/` menu's sections, in the order they are listed. */
export const COMMAND_GROUPS = ['Commands', 'Skills', 'Custom commands', 'Plugins', 'Canopy prompts'] as const
export type CommandGroup = (typeof COMMAND_GROUPS)[number]

/** One row of the `/` menu: a command the provider advertises, or one of Canopy's own prompts. */
export interface CommandItem {
  id: string
  group: CommandGroup
  /** As typed after the slash. */
  name: string
  description: string
  /** What follows the name, e.g. `<file>`; shown as the input's placeholder once picked. */
  argumentHint?: string
  aliases?: readonly string[]
  /** Canopy prompts insert this text; a real command inserts `/name ` instead. */
  prompt?: string
}

/** Canopy's own `/` entries: review-oriented prompts the agent gets verbatim. */
export const CANOPY_PROMPTS: CommandItem[] = [
  { id: 'canopy:summarize', group: 'Canopy prompts', name: 'summarize', description: 'Summarize the changes on this branch', prompt: 'Summarize the changes on this branch in a few bullet points: what changed, why, and anything risky.' },
  { id: 'canopy:explain', group: 'Canopy prompts', name: 'explain', description: 'Explain the current diff line by line where it matters', prompt: 'Walk me through the current diff. Focus on the parts a reviewer would question and explain the reasoning behind them.' },
  { id: 'canopy:tests', group: 'Canopy prompts', name: 'tests', description: 'Ask which tests cover the change', prompt: 'Which tests cover the changes on this branch? Run them if you can and report what passed, failed, or is missing.' },
  { id: 'canopy:risks', group: 'Canopy prompts', name: 'risks', description: 'List regressions this change could cause', prompt: 'List the regressions this change could plausibly cause and how you would verify each one.' }
]

/**
 * Built-ins that do nothing useful from a remote UI: they drive a terminal's own chrome, set up a
 * machine, or exist for the CLI's internals. The provider lists them all; this menu is not a
 * terminal.
 */
const HIDDEN_BUILTINS = new Set(['heapdump', 'color', 'workflow-launch-exec', 'design-consent', 'design-revoke', 'list-agents', 'team-onboarding', 'import', 'auto-mode-setup'])

const GROUP_OF: Record<AgentCommand['source'], CommandGroup | null> = {
  builtin: 'Commands',
  skill: 'Skills',
  custom: 'Custom commands',
  plugin: 'Plugins',
  // Terminal commands are bound to a terminal's UX; nothing here can run them.
  terminal: null
}

/** Whether the `/` menu leaves a command out entirely. */
export function isHiddenCommand(command: AgentCommand): boolean {
  if (GROUP_OF[command.source] === null) return true
  if (command.name.startsWith('__')) return true
  return command.source === 'builtin' && HIDDEN_BUILTINS.has(command.name)
}

/**
 * The `/` menu: what the provider advertises, grouped and ordered, with Canopy's own prompts last.
 * SearchableListbox has no group headers, so the order is the grouping — each row wears its
 * group's name as a tag.
 */
export function commandMenu(commands: readonly AgentCommand[] | undefined): CommandItem[] {
  const advertised = (commands ?? []).filter((command) => !isHiddenCommand(command)).map(
    (command): CommandItem => ({
      id: `${command.source}:${command.name}`,
      group: GROUP_OF[command.source] ?? 'Commands',
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      ...(command.aliases?.length ? { aliases: command.aliases } : {})
    })
  )
  const rank = (item: CommandItem): number => COMMAND_GROUPS.indexOf(item.group)
  return [...advertised, ...CANOPY_PROMPTS].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * `/clear` and its cousins end the conversation rather than saying something in it. Claude Code
 * handles them inside its own process, so Canopy answers them the way it can: a new session.
 */
export function isNewSessionCommand(draft: string): boolean {
  return /^\/(clear|reset|new)\b\s*$/.test(draft.trim())
}

/** The `@` menu's rows: the worktree's changed files, then the subagents the session can address. */
export type MentionItem = { kind: 'file'; id: string; path: string } | { kind: 'agent'; id: string; agent: AgentSubagent }

/** `@agent-<name> ` — the CLI's own syntax for addressing a subagent, so it belongs in the text. */
export const agentMention = (name: string): string => `@agent-${name} `

/** Renders one attachment as the agent should read it. */
const RENDER: Record<ChatComposerAttachmentKind, (a: Attachment) => string> = {
  file: (a) => `- File: ${a.text}`,
  mention: (a) => `- File: ${a.text}`,
  'pasted-text': (a) => `- ${a.label}:\n\`\`\`\n${a.text}\n\`\`\``,
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
