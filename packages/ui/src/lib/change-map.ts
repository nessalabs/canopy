import { ChangeMapSpec, type ChangeMapPart } from '@canopy/shared'

/** A block's schema, as far as reading it goes. */
export interface DrawingSchema<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

/** What a drawn block's JSON describes, or null while it is still arriving or was not one. */
export function parseDrawing<T>(schema: DrawingSchema<T>, source: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(source))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The map an answer's ```change-map block describes, or null while it is still arriving or was not one. */
export const parseChangeMap = (source: string): ChangeMapSpec | null => parseDrawing(ChangeMapSpec, source)

/**
 * Fenced blocks an answer draws rather than prints. Each language becomes an element of the same
 * name carrying the block's source, for the answer's renderer to give a component.
 */
export const DRAWN_BLOCKS: ReadonlySet<string> = new Set(['change-map', 'change-groups', 'call-flow', 'blast-radius', 'before-after', 'data-model'])

const DRAWN = new RegExp(`^\\s*\`\`\`(${[...DRAWN_BLOCKS].join('|')})\\b`, 'm')

/** Whether an answer draws something — it then takes the conversation's whole width. */
export const hasDrawnBlock = (markdown: string): boolean => DRAWN.test(markdown)

/** How a card names its code: the file and its folder, with the lines — `routes/agents.ts:22-26`. */
export const partLabel = (part: ChangeMapPart): string | undefined =>
  part.path ? `${part.path.split('/').slice(-2).join('/')}${part.lines ? `:${part.lines}` : ''}` : undefined

/** Where any drawn part's code is. */
export interface Located {
  path?: string
  lines?: string
}

/** Where a part's code is, as a file reference: `path:lines`, the path alone, or nothing to open. */
export const partRef = (part: Located): string | undefined => (part.path ? (part.lines ? `${part.path}:${part.lines}` : part.path) : undefined)

interface MdCode {
  type: string
  lang?: string | null
  value?: string
  data?: Record<string, unknown>
  children?: MdCode[]
}

function mark(node: MdCode): void {
  // A node type of its own, not a `code` with a new name: code always renders inside a <pre>,
  // which would make a drawing monospace and keep it from taking the answer's width.
  if (node.type === 'code' && node.lang && DRAWN_BLOCKS.has(node.lang)) {
    node.data = { ...node.data, hName: node.lang, hProperties: { source: node.value ?? '' }, hChildren: [] }
    node.type = 'drawnBlock'
  }
  node.children?.forEach(mark)
}

/** A remark plugin: each drawn block renders as a bare element named for its language, carrying its source. */
export const remarkDrawnBlocks = () => (tree: MdCode) => mark(tree)
