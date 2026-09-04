import { codexChangedPaths } from './edit-diffs/written-files'
import { shellWriteTargets } from './edit-diffs/shell-writes'

/** A raw JSON-RPC frame the mapper reads (`{ method, params }` or `{ result }`). */
export type RawFrame = Record<string, unknown>

export interface CodexItem {
  type: string
  id?: string
  text?: string
  content?: Array<{ type: string; text?: string }>
  command?: string | string[]
  cwd?: string
  changes?: unknown
  [key: string]: unknown
}

export interface CodexThread {
  id: string
  cwd?: string
  turns?: Array<{ id?: string; items: CodexItem[]; startedAt?: number | null }>
}

/** The text a Codex item carries, however it carries it (plain, content blocks, or a command). */
export function codexItemText(item: CodexItem): string {
  if (typeof item.text === 'string') return item.text
  if (Array.isArray(item.content)) return item.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).filter(Boolean).join('\n')
  if (typeof item.command === 'string') return item.command
  if (Array.isArray(item.command)) return item.command.join(' ')
  return ''
}

/** Absolute paths a Codex item wrote — shell targets for a command, changed paths for an edit. */
export function codexItemFiles(item: CodexItem): string[] {
  if (item.type === 'commandExecution') return shellWriteTargets(codexItemText(item), typeof item.cwd === 'string' ? item.cwd : undefined)
  if (item.type === 'fileChange') return codexChangedPaths(item.changes)
  return []
}

/**
 * Synthesizes the app-server frames a `thread/read` reply implies, so a replayed Codex thread runs
 * through the very same `CodexAppServerMapper` a live turn does — one code path, no second parser.
 * A `userMessage` item becomes the `turn/start` request that carried it (the mapper has no
 * `userMessage` item case; the prompt lives on the turn); every other item becomes the
 * started/completed pair the live stream would have sent.
 */
export function framesFromThread(thread: CodexThread): RawFrame[] {
  const id = thread.id
  const frames: RawFrame[] = [{ method: 'thread/started', params: { threadId: id, thread: { id, cwd: thread.cwd } } }]
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        const text = codexItemText(item)
        if (text !== '') frames.push({ method: 'turn/start', params: { threadId: id, input: [{ type: 'text', text }] } })
        continue
      }
      frames.push({ method: 'item/started', params: { threadId: id, item } })
      frames.push({ method: 'item/completed', params: { threadId: id, item } })
    }
    frames.push({ method: 'turn/completed', params: { threadId: id, turn: { status: 'completed' } } })
  }
  return frames
}

/** Written files by `callId` (= item id) for a replayed thread's tool items. */
export function filesFromThread(thread: CodexThread): Record<string, string[]> {
  const files: Record<string, string[]> = {}
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items) {
      const written = codexItemFiles(item)
      if (written.length > 0 && item.id) files[item.id] = written
    }
  }
  return files
}
