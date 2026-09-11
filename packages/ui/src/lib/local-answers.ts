/**
 * What a local slash command answered, read back into the facts it printed.
 *
 * Claude Code answers `/context`, `/skill-doctor`, `/model` and `/mcp` inside its own process,
 * as text shaped for a terminal. Each has a fixed template (measured on 2.1.260), so a few
 * anchored patterns recover the structure the transcript can draw — a bar of the context
 * window, a real table, a model picker. Anything that does not match stays a text bubble.
 */

// ---- numbers as the CLI prints them ----

/** "6.8k" → 6800, "1m" → 1_000_000, "~150" → 150, "3.7m" → 3_700_000, "-" → null. */
export function parseTokenCount(text: string): number | null {
  const match = /^~?\s*([\d,.]+)\s*([kKmM])?$/.exec(text.trim())
  if (!match) return null
  const base = Number(match[1]?.replace(/,/g, ''))
  if (!Number.isFinite(base)) return null
  const unit = match[2]?.toLowerCase()
  return Math.round(base * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1))
}

/** 6800 → "6.8k", 955900 → "955.9k", 1000000 → "1m", 235 → "235". */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}m`
  if (value >= 1_000) return `${trim(value / 1_000)}k`
  return String(value)
}
const trim = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, ''))

// ---- markdown tables, as several answers carry them ----

export interface AnswerTable {
  title: string
  columns: string[]
  rows: string[][]
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

/** Every `### Title` followed by a pipe table, in order. */
export function markdownTables(text: string): AnswerTable[] {
  const tables: AnswerTable[] = []
  const lines = text.split('\n')
  let title = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const heading = /^#{2,4}\s+(.+)$/.exec(line.trim())
    if (heading) {
      title = heading[1] ?? ''
      continue
    }
    if (!line.trim().startsWith('|')) continue
    const separator = lines[index + 1] ?? ''
    if (!/^\s*\|?\s*:?-{2,}/.test(separator)) continue
    const columns = cells(line)
    const rows: string[][] = []
    let cursor = index + 2
    while (cursor < lines.length && (lines[cursor] ?? '').trim().startsWith('|')) {
      rows.push(cells(lines[cursor] ?? ''))
      cursor += 1
    }
    tables.push({ title, columns, rows })
    index = cursor - 1
  }
  return tables
}

// ---- /context ----

export interface ContextCategory {
  name: string
  tokens: number
  percent: number
}

export interface ContextReport {
  model?: string
  used: number
  limit: number
  percent: number
  /** What occupies the window, in the order the CLI lists it; free space and the buffer are split out. */
  categories: ContextCategory[]
  free?: ContextCategory
  buffer?: ContextCategory
  /** The detail tables (MCP tools, custom agents, memory files, skills), as printed. */
  details: AnswerTable[]
}

const CATEGORY_TABLE = /usage by category/i

export function parseContextReport(text: string): ContextReport | null {
  if (!/^## Context Usage/m.test(text)) return null
  const tokens = /\*\*Tokens:\*\*\s*([^/]+?)\s*\/\s*(\S+)\s*\((\d+(?:\.\d+)?)%\)/.exec(text)
  const used = tokens ? parseTokenCount(tokens[1] ?? '') : null
  const limit = tokens ? parseTokenCount(tokens[2] ?? '') : null
  if (used === null || limit === null) return null
  const model = /\*\*Model:\*\*\s*(\S+)/.exec(text)?.[1]

  const tables = markdownTables(text)
  const categoryTable = tables.find((table) => CATEGORY_TABLE.test(table.title))
  const categories: ContextCategory[] = []
  let free: ContextCategory | undefined
  let buffer: ContextCategory | undefined
  for (const row of categoryTable?.rows ?? []) {
    const count = parseTokenCount(row[1] ?? '')
    const percent = Number.parseFloat((row[2] ?? '').replace('%', ''))
    if (count === null || !Number.isFinite(percent)) continue
    const entry = { name: row[0] ?? '', tokens: count, percent }
    if (/^free space/i.test(entry.name)) free = entry
    else if (/autocompact/i.test(entry.name)) buffer = entry
    else categories.push(entry)
  }

  return {
    ...(model ? { model } : {}),
    used,
    limit,
    percent: Number.parseFloat(tokens?.[3] ?? '0'),
    categories,
    ...(free ? { free } : {}),
    ...(buffer ? { buffer } : {}),
    details: tables.filter((table) => table !== categoryTable)
  }
}

// ---- /skill-doctor ----

export interface SkillHealth {
  skill: string
  source: string
  /** Tokens the skill's listing costs in context, as printed ("~30"). */
  context: string
  /** Tokens spent on it in the last 7 days, or null for "-". */
  tokens7d: number | null
  uses: number
  /** "never", or how long ago ("2 days"). */
  lastUsed: string
}

export interface SkillDoctorReport {
  title: string
  skills: SkillHealth[]
}

const COLUMNS = /\s{2,}/

export function parseSkillDoctor(text: string): SkillDoctorReport | null {
  const lines = text.split('\n')
  const headerIndex = lines.findIndex((line) => /^\s*skill\s{2,}source\s{2,}/.test(line))
  if (headerIndex === -1) return null
  const title = lines.slice(0, headerIndex).map((line) => line.trim()).find((line) => line !== '') ?? 'Skills'
  const skills: SkillHealth[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() === '') continue
    const parts = line.trim().split(COLUMNS)
    if (parts.length < 6) continue
    const [skill = '', source = '', context = '', tokens = '', uses = '', ...rest] = parts
    skills.push({
      skill,
      source,
      context,
      tokens7d: tokens === '-' ? null : parseTokenCount(tokens),
      uses: Number.parseInt(uses.replace(/×.*$/, ''), 10) || 0,
      lastUsed: rest.join(' ')
    })
  }
  return skills.length > 0 ? { title, skills } : null
}

// ---- /model ----

export interface ModelReport {
  /** As printed, e.g. "Haiku 4.5". */
  current: string
  effort?: string
  /** Aliases the CLI accepts, in the order it lists them. */
  available: string[]
}

export function parseModelReport(text: string): ModelReport | null {
  const current = /^Current model:\s*`?([^`\n(]+?)`?\s*(?:\(effort:\s*(\w+)\))?\s*$/m.exec(text)
  if (!current) return null
  const list = /Available:\s*(.+?)(?:,\s*or a full model ID)?\.?\s*$/m.exec(text)?.[1] ?? ''
  const available = list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !/^or /.test(entry))
  return { current: (current[1] ?? '').trim(), ...(current[2] ? { effort: current[2] } : {}), available }
}

// ---- /mcp ----

export interface McpSummary {
  total: number
  connected: number
  notConnected: number
  disabled: number
}

export function parseMcpSummary(text: string): McpSummary | null {
  const match = /^(\d+) MCP server\(s\):\s*(\d+) connected,\s*(\d+) not connected,\s*(\d+) disabled/m.exec(text)
  if (!match) return null
  return { total: Number(match[1]), connected: Number(match[2]), notConnected: Number(match[3]), disabled: Number(match[4]) }
}

// ---- /list-agents ----

export interface PeerSession {
  /** "busy" | "idle", as printed. */
  status: string
  name: string
  cwd: string
  /** As printed after "started": "1h ago". */
  started: string
}

export interface PeersReport {
  self?: { name: string; id: string }
  /** How many the CLI counted, which may exceed the rows it listed. */
  count: number
  peers: PeerSession[]
}

const SELF = /^This session:\s*(.+?)\s*\[([0-9a-f]+)\]/m
const OTHERS = /^(?:Other Claude sessions|Other sessions)\s*\((\d+)\)/m
const PEER = /^\s*\[(\w+)\]\s*·\s*(.+?)\s*·\s*(.+?)\s*·\s*started\s+(.+?)\s*$/

export function parsePeersReport(text: string): PeersReport | null {
  const self = SELF.exec(text)
  const others = OTHERS.exec(text)
  if (!self && !others) return null
  const peers: PeerSession[] = []
  for (const line of text.split('\n')) {
    const match = PEER.exec(line)
    if (match) peers.push({ status: (match[1] ?? '').toLowerCase(), name: match[2] ?? '', cwd: match[3] ?? '', started: match[4] ?? '' })
  }
  return {
    ...(self ? { self: { name: self[1] ?? '', id: self[2] ?? '' } } : {}),
    count: others ? Number(others[1]) : peers.length,
    peers
  }
}

// ---- which answer is this? ----

/** Built-ins whose whole answer is a sentence or two: a note under the prompt, not an agent bubble. */
const BRIEF_COMMANDS = new Set(['advisor', 'autocompact', 'effort', 'goal', 'rename', 'compact', 'recap', 'color', 'fast', 'design', 'reload-skills', 'reload-plugins', 'import', 'clear', 'reset', 'new', 'name', 'cost', 'stats', 'usage'])

/** The command a prompt invokes, without the slash: "/model opus" → "model"; null for prose. */
export function commandOf(prompt: string | undefined): string | null {
  const match = /^\/([\w:-]+)/.exec((prompt ?? '').trim())
  return match ? (match[1] ?? '').toLowerCase() : null
}

export type LocalAnswer =
  | { kind: 'context'; report: ContextReport }
  | { kind: 'skills'; report: SkillDoctorReport }
  | { kind: 'model'; report: ModelReport }
  | { kind: 'mcp'; summary: McpSummary }
  | { kind: 'peers'; report: PeersReport }
  | { kind: 'note'; text: string }

/**
 * Recognizes a local command's answer by its shape, with the prompt as a tie-breaker for the
 * brief ones (a one-line answer to a prose prompt is the model's own reply and stays a bubble).
 */
export function classifyLocalAnswer(text: string, prompt?: string): LocalAnswer | null {
  const context = parseContextReport(text)
  if (context) return { kind: 'context', report: context }
  const skills = parseSkillDoctor(text)
  if (skills) return { kind: 'skills', report: skills }
  const model = parseModelReport(text)
  if (model) return { kind: 'model', report: model }
  const mcp = parseMcpSummary(text)
  if (mcp) return { kind: 'mcp', summary: mcp }
  const peers = parsePeersReport(text)
  if (peers) return { kind: 'peers', report: peers }

  const command = commandOf(prompt)
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (command && BRIEF_COMMANDS.has(command) && lines.length <= 3 && text.length <= 240) return { kind: 'note', text: lines.join(' ') }
  return null
}
