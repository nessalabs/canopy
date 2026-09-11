/**
 * Pure helpers behind the project settings screen and the new-worktree form: tab deep links,
 * the hint tables the forms render, the create-form summary strip, and the assembly of a
 * `CreateWorktreeInput` from form state. No React, no I/O — all of it is unit tested.
 */
import type { BranchSpec, CacheSource, CacheStrategy, CreateWorktreeInput, DbSource, ProjectEnvVar, WorktrunkHook } from '@canopy/shared'

// =====================================================================================
// Tabs & deep links
// =====================================================================================

/** Every section of the settings screen, in nav order (the last one is machine-level). */
export const SETTINGS_TABS = ['general', 'worktrunk', 'yaml', 'caches', 'defaults', 'cleanup', 'trash', 'danger', 'app'] as const
export type SettingsTabId = (typeof SETTINGS_TABS)[number]

export const SETTINGS_TAB_LABEL: Record<SettingsTabId, string> = {
  general: 'General',
  worktrunk: 'Worktrunk',
  yaml: 'canopy.yaml',
  caches: 'Provisioning & caches',
  defaults: 'Worktree defaults',
  cleanup: 'Cleanup',
  trash: 'Trash',
  danger: 'Danger zone',
  app: 'App preferences'
}

const isTab = (value: string | null): value is SettingsTabId => value !== null && (SETTINGS_TABS as readonly string[]).includes(value)

/**
 * Resolves the requested tab of a deep link. The hash router keeps the path in `location.hash`
 * and — because `wouter`'s hash `navigate` splits it out — the query in `location.search`, so
 * both are accepted: `#/projects/p1/settings?tab=yaml` and `?tab=yaml#/projects/p1/settings`.
 * Anything unknown falls back to `general`.
 */
export function parseSettingsTab(hash: string, search = ''): SettingsTabId {
  const inHash = new URLSearchParams(hash.split('?')[1] ?? '').get('tab')
  if (isTab(inHash)) return inHash
  const inSearch = new URLSearchParams(search.replace(/^\?/, '')).get('tab')
  return isTab(inSearch) ? inSearch : 'general'
}

/** The same absolute URL with `?tab=` pointed at another section; the hash (the route) is kept. */
export function settingsHref(href: string, tab: string): string {
  const url = new URL(href)
  url.searchParams.set('tab', tab)
  return url.toString()
}

// =====================================================================================
// Hint tables
// =====================================================================================

/**
 * What each worktrunk hook actually does. `pre-*` hooks block — a non-zero exit aborts the
 * operation; `post-*` hooks run in the background and cannot fail the command.
 */
export const WORKTRUNK_HOOK_HINT: Record<WorktrunkHook, string> = {
  'pre-switch': 'Blocks every `wt switch`, including switching into an existing worktree. A non-zero exit aborts the switch.',
  'post-switch': 'Runs in the background after every switch, inside the worktree you landed in.',
  'pre-start': 'Blocks once, just before a brand-new worktree is created.',
  'post-start': 'Runs in the background once, right after a worktree is created — this is where Canopy provisions.',
  'pre-commit': 'Blocks `wt commit`; formatters and lint gates go here. A non-zero exit keeps the commit from being made.',
  'post-commit': 'Runs in the background after a commit lands.',
  'pre-merge': 'Blocks `wt merge`; a failing test suite here stops the branch from landing.',
  'post-merge': 'Runs in the background after a successful merge.',
  'pre-remove': 'Blocks `wt remove`; this is where Canopy tears the environment down before the directory goes away.',
  'post-remove': 'Runs in the background once the worktree directory is gone.'
}

/** One-liners for the cache strategies, shown next to each rule. */
export const CACHE_STRATEGY_HINT: Record<CacheStrategy, string> = {
  clone: 'copy-on-write clone — near-instant, disk-cheap',
  copy: 'plain copy — no sharing, costs the disk',
  symlink: 'shared mutable directory — an install in one worktree hits them all',
  fresh: 'nothing is carried over — setup reinstalls it'
}

/** Sentinel for "no per-worktree override" in the create form's cache selects. */
export const CACHE_DEFAULT = '__default__'

/** Template variables Canopy substitutes in the worktree-path setting. */
export const WORKTREE_PATH_VARS = ['{{ repo }}', '{{ name }}', '{{ branch }}', '{{ branch | sanitize }}', '{{ repo_path }}'] as const

// =====================================================================================
// New-worktree form
// =====================================================================================

/** Everything the summary strip above the Advanced accordion needs. */
export interface CreateSummary {
  /** Services selected out of the ones canopy.yaml declares. */
  services: { selected: number; total: number }
  ports: number
  databases: number
  dbSource: DbSource
  /** Name of the worktree a `fromWorktree` source points at. */
  dbSourceName?: string
  copyFiles: number
  /** First cache rule, the headline of the dependency plan. */
  cache?: { path: string; strategy: CacheStrategy } | null
  overrides: number
  skipSetup: boolean
  runtime: 'host' | 'docker' | null
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * The badge labels of the create form's summary strip, in order. Sections the project does not
 * have (no services, no ports, no databases, no cache rules) contribute nothing.
 */
export function summaryBadges(summary: CreateSummary): string[] {
  const badges: string[] = []
  if (summary.services.total > 0) badges.push(`${summary.services.selected}/${summary.services.total} services`)
  if (summary.ports > 0) badges.push(`${count(summary.ports, 'port')} auto`)
  if (summary.databases > 0) {
    const source = summary.dbSource === 'template' ? 'template' : summary.dbSource === 'empty' ? 'empty' : `fork ${summary.dbSourceName ?? 'worktree'}`
    badges.push(`DB: ${source}`)
  }
  if (summary.copyFiles > 0) badges.push(`${count(summary.copyFiles, 'file')} copied`)
  if (summary.cache) badges.push(`${summary.cache.path} ${summary.cache.strategy}`)
  if (summary.overrides > 0) badges.push(count(summary.overrides, 'env override'))
  if (summary.skipSetup) badges.push('setup skipped')
  if (summary.runtime) badges.push(`force ${summary.runtime}`)
  return badges
}

/** Form state of the new-worktree screen, as the controls hold it. */
export interface CreateFormState {
  name: string
  branch: BranchSpec
  /** Run the provisioning pipeline after creation — off when the project has no valid canopy.yaml. */
  provision: boolean
  autoStart: boolean
  /** Every service canopy.yaml declares, so "all of them" can be sent as `null`. */
  allServices: string[]
  selectedServices: string[]
  /** Override rows; blank keys are dropped. */
  env: ProjectEnvVar[]
  dbSource: DbSource
  /** Strategy overrides keyed by cache path — only paths the user actually changed. */
  caches: Record<string, CacheStrategy>
  cacheSource: CacheSource
  skipSetup: boolean
  runtime: 'host' | 'docker' | null
}

/**
 * Turns the form state into the request body. Selecting every service sends `services: null`
 * (the daemon then follows canopy.yaml as it changes), blank env rows are dropped and keys are
 * trimmed, and the selection is normalised to canopy.yaml's own order.
 */
export function buildCreateInput(form: CreateFormState): CreateWorktreeInput {
  const selected = form.allServices.filter((name) => form.selectedServices.includes(name))
  const env = form.env.map((row) => ({ ...row, key: row.key.trim() })).filter((row) => row.key !== '')
  return {
    name: form.name.trim(),
    branch: form.branch,
    provision: form.provision,
    autoStart: form.autoStart,
    options: {
      services: selected.length === form.allServices.length ? null : selected,
      env,
      dbSource: form.dbSource,
      caches: form.caches,
      cacheSource: form.cacheSource,
      skipSetup: form.skipSetup,
      runtime: form.runtime
    }
  }
}

/** Suggests a worktree slug from a branch name: last path segment, slugified. */
export const suggestWorktreeName = (branch: string): string =>
  (branch.split('/').pop() ?? branch)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
