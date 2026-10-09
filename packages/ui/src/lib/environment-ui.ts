/**
 * Pure presentation helpers behind the Environment tab and the Resources popover: uptime and log
 * timestamps, dotenv rendering, meter scales and the memory-bar math. No DOM, no hooks —
 * the components stay thin and this file is unit-tested.
 */
import type { Against, DbInstanceInfo, EnvSource, EnvVar, HostSample } from '@canopy/shared'

export type DashboardTab = 'environment' | 'git' | 'agent'

export const DASHBOARD_TABS: readonly DashboardTab[] = ['environment', 'agent', 'git']

/**
 * Old tab names still found in bookmarks and open windows. Resources moved to the status bar's
 * popover, so a link to it opens Environment, its nearest neighbour.
 */
const TAB_ALIASES: Record<string, DashboardTab> = { gitdiff: 'git', resources: 'environment' }

/** One query parameter out of a hash-router location, or a bare query string. */
function hashParam(hash: string, name: string): string | null {
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
  return query ? new URLSearchParams(query).get(name) : null
}

/**
 * The query a link into a worktree carries. Wouter's hash router writes `navigate('/worktrees/x?tab=git')`
 * as `?tab=git#/worktrees/x`, so the query sits in `location.search`; a hand-typed
 * `#/worktrees/x?tab=git` keeps it in the hash, and that one wins.
 */
export function linkQuery(location: { hash: string; search: string } = window.location): string {
  return location.hash.includes('?') ? location.hash : location.search
}

/**
 * Drops `location.search` once a screen has read its link from it. The hash router never clears
 * it, so it would otherwise ride along to the next route and open that worktree on this link's pane.
 */
export function forgetLinkQuery(): void {
  if (!window.location.search) return
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash)
}

/**
 * Reads `?tab=` out of a hash-router location (`#/worktrees/x?tab=git`). Accepts the
 * raw `location.hash` or a bare query string; unknown tabs return undefined so the caller
 * keeps its own default.
 */
export function parseTab(hash: string): DashboardTab | undefined {
  const raw = hashParam(hash, 'tab')
  const requested = raw !== null ? (TAB_ALIASES[raw] ?? raw) : raw
  return DASHBOARD_TABS.includes(requested as DashboardTab) ? (requested as DashboardTab) : undefined
}

export type GitPane = 'changes' | 'history' | 'pr' | 'comments'

export const GIT_PANES: readonly GitPane[] = ['changes', 'history', 'pr', 'comments']

/**
 * Where a link into the Git tab lands: the pane, what Changes compares against, and the commit
 * History selects — `#/worktrees/x?tab=git&pane=history&commit=<sha>`. Unknown values are dropped.
 */
export interface GitLink {
  pane?: GitPane
  against?: Against
  commit?: string
}

export function parseGitLink(hash: string): GitLink {
  const pane = hashParam(hash, 'pane')
  const against = hashParam(hash, 'against')
  const commit = hashParam(hash, 'commit')
  return {
    pane: GIT_PANES.includes(pane as GitPane) ? (pane as GitPane) : undefined,
    against: against === 'head' || against === 'base' ? against : undefined,
    commit: commit && /^[0-9a-f]{4,40}$/i.test(commit) ? commit : undefined
  }
}

/** The route for a worktree's Git tab opened at `link`. */
export function gitHref(worktreeId: string, link: GitLink): string {
  const params = new URLSearchParams({ tab: 'git' })
  if (link.pane) params.set('pane', link.pane)
  if (link.against) params.set('against', link.against)
  if (link.commit) params.set('commit', link.commit)
  return `/worktrees/${worktreeId}?${params.toString()}`
}

/** "42s" / "9m" / "3h 04m" / "2d 6h" since `startedAt`; null when nothing is running. */
export function uptime(startedAt: number | null | undefined, now = Date.now()): string | null {
  if (startedAt === null || startedAt === undefined) return null
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

/** Local wall clock `HH:MM:SS` for a log line. */
export function logTime(ts: number): string {
  const at = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

export const ENV_SOURCE_LABEL: Record<EnvSource, string> = {
  yaml: 'yaml',
  port: 'port',
  db: 'db',
  project: 'project',
  override: 'override',
  canopy: 'canopy'
}

/** The env rows as a dotenv file — what the "copy all" button puts on the clipboard. */
export function dotenv(env: EnvVar[]): string {
  return env.map((row) => `${row.key}=${/[\s#'"$`\\]/.test(row.value) ? `"${row.value.replace(/(["\\$`])/g, '\\$1')}"` : row.value}`).join('\n')
}

/**
 * What the fork actually holds. `forkedFrom` is only what was *asked* for — when the source
 * database was missing the adapter silently starts empty, which otherwise looks identical to a
 * successful fork until the app hits a missing table. A daemon that never recorded the lineage
 * omits both fields, which is not the same claim as "started empty" — say so rather than guess.
 */
export function lineage(db: DbInstanceInfo): { value: string; hint: string } {
  if (db.status !== 'ready') return { value: db.forkedFrom, hint: 'not forked yet' }
  if (db.forkedFromDatabase === undefined) return { value: db.forkedFrom, hint: 'lineage not recorded' }
  if (db.forkedFromDatabase === null) return { value: 'empty', hint: `${db.forkedFrom} was unavailable` }
  const from = db.forkedFromDatabase.split('/').pop() ?? db.forkedFromDatabase
  return { value: from, hint: db.forkedFromBranch ? `${db.forkedFrom} · ${db.forkedFromBranch}` : db.forkedFrom }
}

/**
 * Fixed categorical assignment shared with the meters: slot i is nessa's chart token i+1,
 * following the series' position — never its rank.
 */
export const SERIES_VARS = [
  'var(--nessa-chart-1)',
  'var(--nessa-chart-2)',
  'var(--nessa-chart-3)',
  'var(--nessa-chart-4)',
  'var(--nessa-chart-5)',
  'var(--nessa-chart-6)'
] as const

/** The chart color for series `index`, wrapping after six. */
export const seriesVar = (index: number): string => SERIES_VARS[index % SERIES_VARS.length]

/** "Nice" ceiling (1/2/2.5/5 × a power of ten) so meter scales don't jitter tick to tick. */
export function niceScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}

/**
 * Meter ceiling for CPU percentages, where one saturated core reads 100: never below 20 so a
 * quiet worktree does not look busy, never above what the host can actually deliver.
 */
export function cpuScale(values: number[], cores: number): number {
  const peak = values.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0)
  return Math.min(Math.max(1, cores) * 100, Math.max(20, niceScale(peak * 1.4)))
}

/** Meter ceiling for megabyte readings; 64 MB keeps a nearly-idle service from pinning the bar. */
export function memScale(values: number[]): number {
  const peak = values.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 64)
  return niceScale(peak * 1.25)
}

export interface MemSegment {
  key: string
  label: string
  memMb: number
  /** Share of the whole machine, 0–1. */
  fraction: number
  kind: 'series' | 'other' | 'free'
  /** Series index, for the chart color. */
  index: number
}

export interface MemBreakdown {
  segments: MemSegment[]
  usedMb: number
  otherMb: number
  freeMb: number
  totalMb: number
}

/**
 * The whole machine's memory as one bar: the named consumers, everything else the host is
 * using, then free. `other` can never go negative (our own sampling can outrun the host
 * sample by a tick) and the segments always sum to the total.
 */
export function memBreakdown(parts: Array<{ name: string; memMb?: number }>, host: HostSample | undefined, hostMemMb: number): MemBreakdown {
  const totalMb = Math.max(1, hostMemMb > 0 ? hostMemMb : (host?.memTotalMb ?? 0))
  const named = parts.map((part) => Math.max(0, part.memMb ?? 0))
  const usedMb = Math.min(totalMb, named.reduce((sum, mb) => sum + mb, 0))
  const otherMb = Math.max(0, Math.min((host?.memUsedMb ?? usedMb) - usedMb, totalMb - usedMb))
  const freeMb = Math.max(0, totalMb - usedMb - otherMb)
  const segments: MemSegment[] = parts.map((part, index) => ({
    key: part.name,
    label: part.name,
    memMb: named[index],
    fraction: named[index] / totalMb,
    kind: 'series' as const,
    index
  }))
  segments.push({ key: '__other', label: 'other processes', memMb: otherMb, fraction: otherMb / totalMb, kind: 'other', index: -1 })
  segments.push({ key: '__free', label: 'free', memMb: freeMb, fraction: freeMb / totalMb, kind: 'free', index: -1 })
  return { segments, usedMb, otherMb, freeMb, totalMb }
}

/**
 * Bar heights (in percent of the box) for a plain-div sparkline, against a nice ceiling so
 * the shape stays comparable between renders. Zero still paints a 2 % stub so the row reads
 * as a timeline rather than a gap.
 */
export function sparkline(values: number[], floor: number): { scale: number; heights: number[] } {
  const scale = niceScale(Math.max(floor, ...values.filter((value) => Number.isFinite(value))))
  return { scale, heights: values.map((value) => (Number.isFinite(value) ? Math.max(2, Math.min(100, (value / scale) * 100)) : 2)) }
}

/** Docker ids are 64 hex characters; the console shows btop's short form. */
export const shortId = (id: string): string => id.slice(0, 12)
