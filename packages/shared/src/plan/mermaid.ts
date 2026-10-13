import { END_ID, START_ID, type DiagramKind, type EdgeStyle, type Field, type Graph, type GraphEdge, type GraphNode, type Shape } from './graph'

/**
 * Reads the Mermaid an agent draws a plan board in. Mermaid is what models already write well and
 * it costs a fraction of the tokens a JSON drawing does, so the agent writes it and Canopy draws
 * its own boxes from it. Only the subset the plan prompt teaches is read; styling (`classDef`,
 * `style`, `click`…) is skipped on purpose, and anything else is reported by line so the agent can
 * fix exactly that line.
 *
 * A fragment — the lines an edit sends — is read with the board's kind and no header.
 */

export interface ParseResult {
  graph: Graph
  /** Ids the lines gave a label or members to — not merely named by an arrow. An edit replaces only these boxes. */
  defined: string[]
  problems: string[]
}

const HEADERS: ReadonlyArray<readonly [RegExp, DiagramKind]> = [
  [/^(flowchart|graph)\b/, 'flowchart'],
  [/^sequenceDiagram\b/, 'sequence'],
  [/^stateDiagram(-v2)?\b/, 'state'],
  [/^erDiagram\b/, 'er'],
  [/^classDiagram\b/, 'class']
]

/** Lines every kind may hold that change nothing about what is drawn. */
const DECORATION = /^(%%|classDef\b|class\s+[\w,-]+\s+\w+\s*;?$|(?:style|linkStyle|click|direction|title|autonumber|activate|deactivate|cssClass)(?:\s|$)|accTitle\b|accDescr\b)/

/** A line's text without a trailing `;`, a `:::class` suffix or a comment. */
const tidy = (line: string): string =>
  line
    .replace(/%%.*$/, '')
    .replace(/:::[\w-]+/g, '')
    .trim()
    .replace(/;$/, '')
    .trim()

/** Label text as a reader sees it: quotes, markdown backticks and `<br>` gone. */
export const cleanLabel = (text: string): string =>
  text
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^`(.*)`$/s, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Collects nodes by id: the first time an id is seen it is added, a later definition with a label replaces it. */
class Builder {
  readonly nodes = new Map<string, GraphNode>()
  readonly edges: GraphEdge[] = []
  readonly problems: string[] = []
  readonly defined = new Set<string>()

  node(id: string, label?: string, shape: Shape = 'box', fields?: Field[]): void {
    if (label !== undefined || fields) this.defined.add(id)
    const known = this.nodes.get(id)
    if (known && label === undefined && !fields) return
    this.nodes.set(id, { id, label: label ?? known?.label ?? id, shape: label === undefined && known ? known.shape : shape, ...((fields ?? known?.fields) ? { fields: fields ?? known?.fields } : {}) })
  }

  /** `A : +z int` — one more member of a class the line does not define, so an edit adds to it. */
  member(id: string, field: Field): void {
    const known = this.nodes.get(id)
    this.nodes.set(id, { id, label: known?.label ?? id, shape: known?.shape ?? 'entity', fields: [...(known?.fields ?? []), field] })
  }

  edge(edge: GraphEdge): void {
    this.edges.push(Object.fromEntries(Object.entries(edge).filter(([, value]) => value !== undefined && value !== '')) as unknown as GraphEdge)
  }

  problem(index: number, line: string, hint: string): void {
    this.problems.push(`line ${index + 1}: "${line}" — ${hint}`)
  }

  graph(kind: DiagramKind): ParseResult {
    return { graph: { kind, nodes: [...this.nodes.values()], edges: this.edges }, defined: [...this.defined], problems: this.problems }
  }
}

type LineReader = (line: string, index: number, b: Builder) => void

// ---- flowchart ----

/** Opening and closing delimiters of a node's shape, longest first so `((` wins over `(`. */
const SHAPES: ReadonlyArray<readonly [string, string, Shape]> = [
  ['((', '))', 'circle'],
  ['([', '])', 'round'],
  ['[(', ')]', 'store'],
  ['[[', ']]', 'box'],
  ['{{', '}}', 'box'],
  ['[/', '/]', 'box'],
  ['[\\', '\\]', 'box'],
  ['[/', '\\]', 'box'],
  ['[', ']', 'box'],
  ['(', ')', 'round'],
  ['{', '}', 'decision'],
  ['>', ']', 'box']
]

const NODE = /^([A-Za-z_][\w.-]*)\s*(.*)$/

/** `a[Label]` → its id, label and shape; a bare id has neither. Undefined when it is not a node. */
function readNode(text: string): { id: string; label?: string; shape: Shape } | undefined {
  const match = NODE.exec(text.trim())
  if (!match) return undefined
  const [, id, rest] = match
  if (!rest) return { id: id!, shape: 'box' }
  const shape = SHAPES.find(([open, close]) => rest.startsWith(open) && rest.endsWith(close))
  return shape ? { id: id!, label: cleanLabel(rest.slice(shape[0].length, rest.length - shape[1].length)), shape: shape[2] } : undefined
}

/** `-- text -->` and its dotted and thick forms, rewritten as `-->|text|` so one arrow pattern reads them all. */
const INLINE_LABEL = /\s(--|==|-\.)\s+([^|>\s][^|>]*?)\s+(-{2,}>|={2,}>|\.-+>|-{3,}|={3,}|\.-+)\s/g
const ARROW = /\s*(<?(?:-\.+->|-\.+-|-{2,}>|-{3,}|={2,}>|={3,}|--[xo]))\s*(?:\|([^|]*)\|)?\s*/
const ARROW_SPLIT = new RegExp(ARROW.source.replace(/\((?!\?)/g, '(?:'), 'g')

/** `&` between nodes joins them into a group; inside a label it is a word. */
const GROUP_AND = /\s+&\s+(?![^[({]*[\])}])/

const arrowStyle = (arrow: string): EdgeStyle => (arrow.includes('.') ? 'dashed' : arrow.includes('=') ? 'thick' : 'solid')

const readFlowchartLine: LineReader = (raw, index, b) => {
  const line = ` ${raw} `.replace(INLINE_LABEL, ' $1$3|$2| ').trim()
  if (/^subgraph\b/.test(line) || line === 'end') return
  const groups = line.split(ARROW_SPLIT)
  const arrows = [...line.matchAll(new RegExp(ARROW.source, 'g'))]
  const nodes = groups.map((group) => group.split(GROUP_AND).map(readNode))
  if (nodes.some((group) => group.some((node) => !node))) return b.problem(index, raw, 'not a node or arrow; write `a[Label]`, `a --> b` or `a -->|label| b`')
  for (const group of nodes) for (const node of group) b.node(node!.id, node!.label, node!.shape)
  arrows.forEach(([, arrow, label], i) => {
    for (const from of nodes[i]!) for (const to of nodes[i + 1]!) b.edge({ from: from!.id, to: to!.id, label: label === undefined ? undefined : cleanLabel(label), style: arrowStyle(arrow!) })
  })
}

// ---- sequence ----

const MESSAGE = /^(\w+(?:[.-]\w+)*)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?\s*(\w+(?:[.-]\w+)*)\s*:\s*(.*)$/
const PARTICIPANT = /^(participant|actor)\s+([\w.-]+)(?:\s+as\s+(.+))?$/
const OPENS_BRANCH = /^(alt|opt|loop|par|critical|break)\b\s*(.*)$/
const SWITCHES_BRANCH = /^(else|and|option)\b\s*(.*)$/
const OPENS_FRAME = /^(rect|box)\b/
const NOTE = /^note\b/i

const messageStyle = (arrow: string): EdgeStyle => (arrow.endsWith(')') ? 'async' : arrow.startsWith('--') ? 'return' : 'call')

/** Sequence reading keeps a stack of open frames; a branch frame names the condition its messages run under. */
function sequenceReader(): LineReader {
  const frames: Array<string | null> = []
  const branch = (): string | undefined => [...frames].reverse().find((frame) => frame !== null) ?? undefined
  return (line, index, b) => {
    const participant = PARTICIPANT.exec(line)
    if (participant) return b.node(participant[2]!, participant[3] ? cleanLabel(participant[3]) : undefined, participant[1] === 'actor' ? 'actor' : 'participant')
    const message = MESSAGE.exec(line)
    if (message) {
      const [, from, arrow, to, text] = message
      b.node(from!, undefined, 'participant')
      b.node(to!, undefined, 'participant')
      return b.edge({ from: from!, to: to!, label: cleanLabel(text!), style: messageStyle(arrow!), branch: branch() })
    }
    const opens = OPENS_BRANCH.exec(line)
    if (opens) return void frames.push(cleanLabel(opens[2] || opens[1]!))
    const switches = SWITCHES_BRANCH.exec(line)
    if (switches && frames.length > 0) return void frames.splice(-1, 1, cleanLabel(switches[2] || switches[1]!))
    if (OPENS_FRAME.test(line)) return void frames.push(null)
    if (line === 'end') return void frames.pop()
    if (NOTE.test(line)) return
    b.problem(index, line, 'not a participant or message; write `participant a as Label` or `a->>b: what it asks`')
  }
}

// ---- state ----

const TRANSITION = /^(\[\*\]|\w+(?:[.-]\w+)*)\s*-->\s*(\[\*\]|\w+(?:[.-]\w+)*)\s*(?::\s*(.*))?$/
const STATE_ALIAS = /^state\s+"([^"]+)"\s+as\s+([\w.-]+)/
const STATE_KIND = /^state\s+([\w.-]+)\s*<<(choice|fork|join)>>/
const STATE_BLOCK = /^state\s+([\w.-]+)\s*\{?$/
const STATE_LABEL = /^([\w.-]+)\s*:\s*(.+)$/
const GUARD = /^(.*?)\s*\[([^\]]+)\]\s*$/

const pseudo = (end: string, at: 'from' | 'to'): string => (end === '[*]' ? (at === 'from' ? START_ID : END_ID) : end)

function stateReader(): LineReader {
  let inNote = false
  return (line, index, b) => {
    if (inNote) return void (inNote = !/^end\s+note$/i.test(line))
    if (/^note\b/i.test(line)) return void (inNote = !line.includes(':'))
    if (line === '}' || line === '--') return
    const transition = TRANSITION.exec(line)
    if (transition) {
      const [, rawFrom, rawTo, text] = transition
      const from = pseudo(rawFrom!, 'from')
      const to = pseudo(rawTo!, 'to')
      b.node(from, from === START_ID ? 'Start' : undefined, from === START_ID ? 'initial' : 'box')
      b.node(to, to === END_ID ? 'End' : undefined, to === END_ID ? 'final' : 'box')
      const guarded = text ? GUARD.exec(text) : null
      return b.edge({ from, to, label: guarded ? cleanLabel(guarded[1]!) : text && cleanLabel(text), guard: guarded?.[2], style: 'solid' })
    }
    const alias = STATE_ALIAS.exec(line)
    if (alias) return b.node(alias[2]!, cleanLabel(alias[1]!))
    const kind = STATE_KIND.exec(line)
    if (kind) return b.node(kind[1]!, undefined, kind[2] === 'choice' ? 'decision' : 'box')
    const block = STATE_BLOCK.exec(line)
    if (block) return b.node(block[1]!)
    const label = STATE_LABEL.exec(line)
    if (label) return b.node(label[1]!, cleanLabel(label[2]!))
    b.problem(index, line, 'not a state or transition; write `a --> b : event [guard]` or `state "Label" as a`')
  }
}

// ---- entity-relationship ----

const CARDINALITY: Record<string, string> = { '||': '1', '|o': '0..1', 'o|': '0..1', '}|': '1..N', '|{': '1..N', '}o': '0..N', 'o{': '0..N' }
const RELATION = /^([\w.-]+)\s+([|}o][|o])(--|\.\.)([|o][|{o])\s+([\w.-]+)\s*:\s*(.+)$/
const ENTITY_OPEN = /^([\w.-]+)(?:\s*\[\s*"?([^"\]]+)"?\s*\])?\s*\{$/
const ATTRIBUTE = /^(\S+)\s+(\S+)((?:\s+(?:PK|FK|UK)\s*,?)*)\s*(?:"(.*)")?$/
const KEY: Record<string, Field['key']> = { PK: 'primary', FK: 'foreign' }

/** Members gathered inside a `{ … }` block, handed to `close` when the block ends. */
function blockReader(open: RegExp, member: (line: string) => Field | undefined, body: (line: string, index: number, b: Builder) => void, shape: Shape): LineReader {
  let current: { id: string; label?: string; fields: Field[] } | undefined
  return (line, index, b) => {
    if (current) {
      if (line === '}') {
        b.node(current.id, current.label ?? current.id, shape, current.fields)
        current = undefined
        return
      }
      if (/^<<.*>>$/.test(line)) return
      const field = member(line)
      if (field) return void current.fields.push(field)
      return b.problem(index, line, 'not a member; write `type name` (entity) or `+name type` / `+method()` (class)')
    }
    const opened = open.exec(line)
    if (opened) return void (current = { id: opened[1]!, label: opened[2] && cleanLabel(opened[2]), fields: [] })
    body(line, index, b)
  }
}

const erAttribute = (line: string): Field | undefined => {
  const match = ATTRIBUTE.exec(line)
  if (!match) return undefined
  const key = (match[3] ?? '').split(/[\s,]+/).map((k) => KEY[k]).find(Boolean)
  return { name: match[2]!, type: match[1]!, ...(key ? { key } : {}), ...(match[4] ? { note: match[4] } : {}) }
}

const erBody = (line: string, index: number, b: Builder): void => {
  const relation = RELATION.exec(line)
  if (relation) {
    const [, from, left, dash, right, to, label] = relation
    b.node(from!, undefined, 'entity')
    b.node(to!, undefined, 'entity')
    return b.edge({ from: from!, to: to!, label: cleanLabel(label!), cardinality: `${CARDINALITY[left!]}:${CARDINALITY[right!]}`, style: dash === '..' ? 'dashed' : 'solid' })
  }
  if (/^[\w.-]+$/.test(line)) return b.node(line, undefined, 'entity')
  b.problem(index, line, 'not an entity or relation; write `A ||--o{ B : "has"` or `A { string name PK }`')
}

// ---- class ----

/** Class relations as written, read left to right: which way the arrow points and what it means. */
const CLASS_LINKS: ReadonlyArray<readonly [string, 'ltr' | 'rtl', string, EdgeStyle]> = [
  ['<|--', 'rtl', 'extends', 'solid'],
  ['--|>', 'ltr', 'extends', 'solid'],
  ['<|..', 'rtl', 'implements', 'dashed'],
  ['..|>', 'ltr', 'implements', 'dashed'],
  ['*--', 'ltr', 'owns', 'solid'],
  ['--*', 'rtl', 'owns', 'solid'],
  ['o--', 'ltr', 'holds', 'solid'],
  ['--o', 'rtl', 'holds', 'solid'],
  ['-->', 'ltr', 'uses', 'solid'],
  ['<--', 'rtl', 'uses', 'solid'],
  ['..>', 'ltr', 'depends on', 'dashed'],
  ['<..', 'rtl', 'depends on', 'dashed'],
  ['--', 'ltr', '', 'solid'],
  ['..', 'ltr', '', 'dashed']
]
const escape = (text: string): string => text.replace(/[|*.+?^${}()[\]\\]/g, '\\$&')
const CLASS_LINK = new RegExp(`^([\\w.-]+)\\s*(?:"[^"]*"\\s*)?(${CLASS_LINKS.map(([arrow]) => escape(arrow)).join('|')})\\s*(?:"[^"]*"\\s*)?([\\w.-]+)\\s*(?::\\s*(.*))?$`)
const CLASS_OPEN = /^class\s+([\w.-]+)(?:\s*\[\s*"?([^"\]]+)"?\s*\])?(?:~[^~]*~)?\s*\{$/
const CLASS_DECL = /^class\s+([\w.-]+)(?:\s*\[\s*"?([^"\]]+)"?\s*\])?(?:~[^~]*~)?$/
const CLASS_MEMBER_LINE = /^([\w.-]+)\s*:\s*(.+)$/

/** `+start(text) Turn` or `-turns Map` → a field; methods keep their parentheses in the name. */
const classMember = (line: string): Field | undefined => {
  if (/^<<.*>>$/.test(line)) return undefined
  const text = line.replace(/^[+\-#~]/, '').replace(/[$*]$/, '').trim()
  if (!text) return undefined
  const method = /^(.*\))\s*(.*)$/.exec(text)
  if (method) return { name: method[1]!, ...(method[2] ? { type: method[2] } : {}) }
  const [first, ...rest] = text.split(/\s+/)
  // Mermaid allows both `Type name` and `name Type`; a capitalised first word reads as the type.
  if (rest.length === 0) return { name: first! }
  return /^[A-Z]/.test(first!) ? { name: rest.join(' '), type: first! } : { name: first!, type: rest.join(' ') }
}

const classBody = (line: string, index: number, b: Builder): void => {
  if (/^namespace\b/.test(line) || line === '}' || /^<<.*>>/.test(line) || /^note\b/.test(line)) return
  const link = CLASS_LINK.exec(line)
  if (link) {
    const [, left, arrow, right, label] = link
    const [, direction, meaning, style] = CLASS_LINKS.find(([a]) => a === arrow)!
    b.node(left!, undefined, 'entity')
    b.node(right!, undefined, 'entity')
    const [from, to] = direction === 'ltr' ? [left!, right!] : [right!, left!]
    return b.edge({ from, to, label: label ? cleanLabel(label) : meaning || undefined, style })
  }
  const decl = CLASS_DECL.exec(line)
  if (decl) return b.node(decl[1]!, decl[2] ? cleanLabel(decl[2]) : undefined, 'entity')
  const member = CLASS_MEMBER_LINE.exec(line)
  const field = member ? classMember(member[2]!) : undefined
  if (member && field) return b.member(member[1]!, field)
  b.problem(index, line, 'not a class or relation; write `class A { +name Type }` or `A <|-- B`')
}

// ---- dispatch ----

const READERS: Record<DiagramKind, () => LineReader> = {
  flowchart: () => readFlowchartLine,
  sequence: sequenceReader,
  state: stateReader,
  er: () => blockReader(ENTITY_OPEN, erAttribute, erBody, 'entity'),
  class: () => blockReader(CLASS_OPEN, classMember, classBody, 'entity')
}

/** The kind a whole diagram's first line declares, if it is one the plan reads. */
export const headerKind = (line: string): DiagramKind | undefined => HEADERS.find(([pattern]) => pattern.test(line.trim()))?.[1]

/** The diagram without a ```mermaid fence the agent may have wrapped it in. */
const unfenced = (source: string): string => source.replace(/^\s*```(?:mermaid)?\s*\n/, '').replace(/\n?```\s*$/, '')

/**
 * A fragment for a board of `kind`: a fence or a header repeating the kind is dropped (blank lines
 * keep their place, so problems are numbered as written), since the agent often sends both.
 */
export function fragmentOf(kind: DiagramKind, source: string): string {
  const lines = unfenced(source).split('\n')
  const start = lines.findIndex((line) => tidy(line) !== '')
  return start !== -1 && headerKind(tidy(lines[start]!)) === kind ? lines.map((line, index) => (index === start ? '' : line)).join('\n') : lines.join('\n')
}

/** Reads diagram lines of a known kind — a fragment, or a whole diagram's lines after its header. */
export function parseLines(kind: DiagramKind, source: string): ParseResult {
  const b = new Builder()
  const read = READERS[kind]()
  source.split('\n').forEach((raw, index) => {
    const line = tidy(raw)
    if (!line || DECORATION.test(line)) return
    read(line, index, b)
  })
  return b.graph(kind)
}

/** Reads a whole diagram, header first. Strips a ```mermaid fence the agent may have wrapped it in. */
export function parseMermaid(source: string): ParseResult {
  const lines = unfenced(source).split('\n')
  const start = lines.findIndex((line) => tidy(line) !== '')
  const kind = start === -1 ? undefined : headerKind(tidy(lines[start]!))
  if (!kind) return { graph: { kind: 'flowchart', nodes: [], edges: [] }, defined: [], problems: ['the first line must name the diagram: flowchart TD, sequenceDiagram, stateDiagram-v2, erDiagram or classDiagram'] }
  // Blank lines keep their place so a problem's line number matches what the agent wrote.
  const body = lines.map((line, index) => (index <= start ? '' : line)).join('\n')
  return parseLines(kind, body)
}
