/**
 * The `/usage` answer, read back into the numbers it flattens.
 *
 * Claude Code prints plan limits as prose: one line per rate-limit window, then a "what's
 * contributing" section per period with two behaviour percentages and three ranked lists. It is a
 * fixed template (measured against 2.1.260), so a few anchored patterns recover the structure the
 * transcript can draw as meters and lists. Anything that does not match the template — an API-key
 * session, a future wording — parses to null and stays a text bubble.
 */

export interface UsageWindow {
  /** As printed: "Current session", "Current week (all models)", "Current week (Fable)". */
  label: string
  /** 0–100. */
  percent: number
  /** As printed after "resets", zone dropped: "Sep 10 at 11:19pm". */
  resetsAt?: string
  /** The zone the reset time is given in, when printed: "America/Chicago". */
  zone?: string
}

export interface UsageShare {
  name: string
  /** 0–100. */
  percent: number
}

export interface UsagePeriod {
  /** "Last 24h", "Last 7d". */
  label: string
  requests: number
  sessions: number
  /** "of your usage came from subagent-heavy sessions" → { percent: 72, what: 'subagent-heavy sessions' }. */
  behaviors: Array<{ percent: number; what: string }>
  skills: UsageShare[]
  subagents: UsageShare[]
  mcpServers: UsageShare[]
}

export interface UsageReport {
  /** The opening sentence: how the session is paid for. */
  plan: string
  windows: UsageWindow[]
  /** The caveat under the contributing heading, when printed. */
  note?: string
  periods: UsagePeriod[]
}

const WINDOW = /^(Current [^:]+): (\d+)% used(?: · resets (.+?))?$/
const RESET_ZONE = /^(.*?)\s*\(([^)]+)\)$/
const PERIOD = /^(Last \S+) · ([\d,]+) requests? · ([\d,]+) sessions?$/
const BEHAVIOR = /^(\d+)% of your usage (.+)$/
const TOP = /^Top (skills|subagents|MCP servers): (.*)$/
const SHARE = /^(.+?) (\d+)%$/
const CONTRIBUTING = /^What's contributing/i

const int = (digits: string): number => Number(digits.replace(/,/g, ''))

/** Turns "of your usage came from subagent-heavy sessions" into the part worth printing next to the number. */
function behaviourLabel(rest: string): string {
  return rest
    .replace(/^came from /, '')
    .replace(/^was /, '')
    .trim()
}

function shares(list: string): UsageShare[] {
  return list
    .split(', ')
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const match = SHARE.exec(entry)
      return match ? [{ name: match[1] ?? entry, percent: int(match[2] ?? '0') }] : []
    })
}

/** Whether a text is the `/usage` template at all, cheaply, before the full parse. */
export function looksLikeUsageReport(text: string): boolean {
  return /^Current (session|week)[^:]*: \d+% used/m.test(text)
}

export function parseUsageReport(text: string): UsageReport | null {
  if (!looksLikeUsageReport(text)) return null
  const lines = text.split('\n').map((line) => line.trimEnd())
  const nonEmpty = lines.map((line) => line.trim()).filter((line) => line !== '')
  const plan = nonEmpty.find((line) => !WINDOW.test(line)) ?? ''

  const windows: UsageWindow[] = []
  const periods: UsagePeriod[] = []
  let note: string | undefined
  let awaitingNote = false
  let current: UsagePeriod | undefined

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue

    const window = WINDOW.exec(line)
    if (window) {
      const entry: UsageWindow = { label: window[1] ?? '', percent: int(window[2] ?? '0') }
      const reset = window[3]
      if (reset) {
        const zoned = RESET_ZONE.exec(reset)
        entry.resetsAt = zoned ? (zoned[1] ?? reset) : reset
        if (zoned?.[2]) entry.zone = zoned[2]
      }
      windows.push(entry)
      continue
    }

    if (CONTRIBUTING.test(line)) {
      awaitingNote = true
      continue
    }

    const period = PERIOD.exec(line)
    if (period) {
      awaitingNote = false
      current = { label: period[1] ?? '', requests: int(period[2] ?? '0'), sessions: int(period[3] ?? '0'), behaviors: [], skills: [], subagents: [], mcpServers: [] }
      periods.push(current)
      continue
    }

    if (awaitingNote) {
      note = note ? `${note} ${line}` : line
      continue
    }
    if (!current) continue

    const behavior = BEHAVIOR.exec(line)
    if (behavior) {
      current.behaviors.push({ percent: int(behavior[1] ?? '0'), what: behaviourLabel(behavior[2] ?? '') })
      continue
    }
    const top = TOP.exec(line)
    if (top) {
      const list = shares(top[2] ?? '')
      if (top[1] === 'skills') current.skills = list
      else if (top[1] === 'subagents') current.subagents = list
      else current.mcpServers = list
    }
  }

  return windows.length > 0 ? { plan, windows, ...(note ? { note } : {}), periods } : null
}

/** How loud a window's fill should be: the closer to the limit, the more the meter warns. */
export type UsageSeverity = 'ok' | 'warn' | 'critical'

export function usageSeverity(percent: number): UsageSeverity {
  if (percent >= 90) return 'critical'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** A count for a stat: 1468 → "1,468". */
export const formatCount = (value: number): string => value.toLocaleString('en-US')
