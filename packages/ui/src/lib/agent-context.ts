import type { StagedText } from './use-staging'

/** The drag type Canopy's own sources use, so a drop knows a path from a pasted word. */
export const CONTEXT_MIME = 'application/x-canopy-context'

/** Something worth showing an agent: a file or folder of the change, or a piece of code or text. */
export type AgentContext =
  | { kind: 'path'; path: string; dir: boolean }
  | { kind: 'snippet'; text: string; path?: string; lines?: readonly [number, number] }

const baseName = (path: string): string => path.split('/').pop() || path
const span = ([from, to]: readonly [number, number]): string => (from === to ? `${from}` : `${from}–${to}`)

/**
 * The chip for it. A file goes by its name on the chip and its path to the agent; a snippet is
 * named after where it came from, which is also how the agent reads it.
 */
export function toStaged(context: AgentContext): Omit<StagedText, 'id'> {
  if (context.kind === 'path') return { kind: 'file', label: context.dir ? `${baseName(context.path)}/` : baseName(context.path), text: context.dir ? `${context.path}/` : context.path }
  const where = context.path ? `${context.path}${context.lines ? `:${span(context.lines)}` : ''}` : undefined
  return { kind: 'pasted-text', label: where ?? `Selected text (${context.text.split('\n').length} lines)`, text: context.text }
}

const isContext = (value: unknown): value is AgentContext => {
  const v = value as Partial<Record<string, unknown>> | null
  return (v?.kind === 'path' && typeof v.path === 'string') || (v?.kind === 'snippet' && typeof v.text === 'string')
}

/** What a drop carries: Canopy's own context first, else any plain text as a snippet. */
export function readDrop(data: Pick<DataTransfer, 'getData'>): AgentContext | null {
  try {
    const parsed: unknown = JSON.parse(data.getData(CONTEXT_MIME) || 'null')
    if (isContext(parsed)) return parsed
  } catch {
    // not ours; fall through to text
  }
  const text = data.getData('text/plain').trim()
  return text ? { kind: 'snippet', text } : null
}
