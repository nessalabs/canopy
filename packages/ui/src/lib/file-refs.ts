/**
 * File references in an agent's answer — `src/a.ts:42`, `src/a.ts:42-50`, `src/a.ts#L42-L50` —
 * the way Claude Code and Codex cite code. They become links, and a link becomes a jump to that
 * file and those lines in the Git tab.
 */

/** Lines of a file, first to last, as the new side of a diff numbers them. */
export interface LineRange {
  start: number
  end: number
}

export interface FileRef {
  path: string
  /** The cited lines; absent when only the file was named. */
  lines?: LineRange
}

// A path with an extension that starts with a letter, so `1.5:3` or a version number never reads as one.
const PATH = String.raw`(?:\.?\/)?(?:[\w.@~+-]+\/)*[\w@~+-][\w.@~+-]*\.[A-Za-z][A-Za-z0-9]*`
const LINES = String.raw`(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)`
const WHOLE = new RegExp(`^(${PATH})${LINES}?$`)
const IN_TEXT = new RegExp(`(?<![\\w/.])(${PATH})${LINES}(?![\\w])`, 'g')

function toRef(match: RegExpExecArray): FileRef {
  const [, path = '', colonStart, colonEnd, hashStart, hashEnd] = match
  const start = Number(colonStart ?? hashStart)
  const end = Number(colonEnd ?? hashEnd ?? start)
  return { path: path.replace(/^\.\//, ''), ...(start > 0 ? { lines: { start, end: Math.max(start, end) } } : {}) }
}

/**
 * The reference `text` is — the whole of it — or null. `root` is the checkout the agent ran in:
 * an absolute path under it is read relative to it, the way the Git tab names files.
 */
export function parseFileRef(text: string, root?: string): FileRef | null {
  const match = WHOLE.exec(text.trim())
  if (!match) return null
  const ref = toRef(match)
  const prefix = root ? `${root.replace(/\/$/, '')}/` : undefined
  return prefix && ref.path.startsWith(prefix) ? { ...ref, path: ref.path.slice(prefix.length) } : ref
}

/**
 * The file a reference means among the ones the Git tab knows: itself, or the one path it is the
 * unique tail of — agents often cite `routes/agents.ts` for `packages/daemon/src/routes/agents.ts`.
 * Anything else is taken as written, relative to the checkout.
 */
export function resolvePath(path: string, known: readonly string[]): string {
  if (known.includes(path)) return path
  const tails = known.filter((candidate) => candidate.endsWith(`/${path}`))
  return tails.length === 1 ? tails[0]! : path
}

/** The pieces of a run of prose: plain text, and the references in it with their source text. */
export function splitRefs(text: string): Array<string | { raw: string; ref: FileRef }> {
  const parts: Array<string | { raw: string; ref: FileRef }> = []
  let last = 0
  for (const match of text.matchAll(IN_TEXT)) {
    const index = match.index ?? 0
    if (index > last) parts.push(text.slice(last, index))
    parts.push({ raw: match[0], ref: toRef(match as RegExpExecArray) })
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** The slice of mdast this touches. */
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

const link = (url: string, child: MdNode): MdNode => ({ type: 'link', url, children: [child] })

function linkify(node: MdNode): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === 'text' && child.value) return splitRefs(child.value).map((part) => (typeof part === 'string' ? { type: 'text', value: part } : link(part.raw, { type: 'text', value: part.raw })))
    // A code span that is only a reference with lines: `src/a.ts:42`. A bare `a.ts` stays code.
    if (child.type === 'inlineCode' && child.value && parseFileRef(child.value)?.lines) return [link(child.value.trim(), child)]
    linkify(child)
    return [child]
  })
}

/** A remark plugin: every file reference in prose or in a code span of its own becomes a link to it. */
export const remarkFileRefs = () => (tree: MdNode) => linkify(tree)
