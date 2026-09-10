import { describe, expect, it } from 'vitest'

import { WORKTRUNK_HOOKS } from '@canopy/shared'

import {
  CACHE_STRATEGY_HINT,
  SETTINGS_TABS,
  SETTINGS_TAB_LABEL,
  WORKTRUNK_HOOK_HINT,
  buildCreateInput,
  parseSettingsTab,
  settingsHref,
  suggestWorktreeName,
  summaryBadges,
  type CreateFormState,
  type CreateSummary
} from '../src/lib/settings-ui'

describe('tab deep links', () => {
  it('reads the tab out of the hash', () => {
    expect(parseSettingsTab('#/projects/p1/settings?tab=yaml')).toBe('yaml')
    expect(parseSettingsTab('#/projects/p1/settings?other=1&tab=danger')).toBe('danger')
  })

  it('reads the tab out of the search, where the hash router puts it', () => {
    expect(parseSettingsTab('#/projects/p1/settings', '?tab=caches')).toBe('caches')
    expect(parseSettingsTab('#/projects/p1/settings', 'tab=app')).toBe('app')
  })

  it('falls back to general for a missing or unknown tab', () => {
    expect(parseSettingsTab('#/projects/p1/settings')).toBe('general')
    expect(parseSettingsTab('#/projects/p1/settings?tab=nope')).toBe('general')
    expect(parseSettingsTab('', '')).toBe('general')
  })

  it('prefers the hash over the search when both name a tab', () => {
    expect(parseSettingsTab('#/x?tab=cleanup', '?tab=yaml')).toBe('cleanup')
  })

  it('rewrites the tab query while keeping the route in the hash', () => {
    expect(settingsHref('http://localhost:5173/#/projects/p1/settings', 'yaml')).toBe('http://localhost:5173/?tab=yaml#/projects/p1/settings')
    expect(settingsHref('http://localhost:5173/?tab=yaml#/projects/p1/settings', 'danger')).toBe('http://localhost:5173/?tab=danger#/projects/p1/settings')
  })

  it('round-trips every tab', () => {
    for (const tab of SETTINGS_TABS) {
      expect(parseSettingsTab('', new URL(settingsHref('http://x/#/s', tab)).search)).toBe(tab)
      expect(SETTINGS_TAB_LABEL[tab]).toBeTruthy()
    }
  })
})

describe('hint tables', () => {
  it('has a hint for every worktrunk hook and nothing extra', () => {
    expect(Object.keys(WORKTRUNK_HOOK_HINT).sort()).toEqual([...WORKTRUNK_HOOKS].sort())
    for (const hook of WORKTRUNK_HOOKS) expect(WORKTRUNK_HOOK_HINT[hook].length).toBeGreaterThan(20)
  })

  it('says whether each hook blocks', () => {
    for (const hook of WORKTRUNK_HOOKS) {
      const hint = WORKTRUNK_HOOK_HINT[hook]
      expect(hook.startsWith('pre-') ? /block/i.test(hint) : /background/i.test(hint)).toBe(true)
    }
  })

  it('has a hint for every cache strategy', () => {
    expect(Object.keys(CACHE_STRATEGY_HINT).sort()).toEqual(['clone', 'copy', 'fresh', 'symlink'])
  })
})

const summary = (patch: Partial<CreateSummary> = {}): CreateSummary => ({
  services: { selected: 2, total: 3 },
  ports: 2,
  databases: 1,
  dbSource: 'template',
  copyFiles: 3,
  cache: { path: 'node_modules', strategy: 'clone' },
  overrides: 0,
  skipSetup: false,
  runtime: null,
  ...patch
})

describe('summary strip', () => {
  it('describes the plan', () => {
    expect(summaryBadges(summary())).toEqual(['2/3 services', '2 ports auto', 'DB: template', '3 files copied', 'node_modules clone'])
  })

  it('names the worktree a database forks from', () => {
    expect(summaryBadges(summary({ dbSource: { fromWorktree: 'wt-1' }, dbSourceName: 'billing' }))).toContain('DB: fork billing')
    expect(summaryBadges(summary({ dbSource: 'empty' }))).toContain('DB: empty')
  })

  it('adds the optional badges only when they apply', () => {
    expect(summaryBadges(summary({ overrides: 1, skipSetup: true, runtime: 'docker' })).slice(-3)).toEqual(['1 env override', 'setup skipped', 'force docker'])
    expect(summaryBadges(summary({ overrides: 2 }))).toContain('2 env overrides')
  })

  it('stays silent about sections the project does not have', () => {
    expect(summaryBadges(summary({ services: { selected: 0, total: 0 }, ports: 0, databases: 0, copyFiles: 0, cache: null }))).toEqual([])
  })

  it('uses the singular for one port and one file', () => {
    expect(summaryBadges(summary({ ports: 1, copyFiles: 1 }))).toEqual(['2/3 services', '1 port auto', 'DB: template', '1 file copied', 'node_modules clone'])
  })
})

const form = (patch: Partial<CreateFormState> = {}): CreateFormState => ({
  name: ' fix-auth ',
  branch: { mode: 'new', name: 'igaurab/fix-auth', base: 'main' },
  provision: true,
  autoStart: true,
  allServices: ['api', 'web', 'worker'],
  selectedServices: ['api', 'web', 'worker'],
  env: [],
  dbSource: 'template',
  caches: {},
  cacheSource: 'primary',
  skipSetup: false,
  runtime: null,
  ...patch
})

describe('buildCreateInput', () => {
  it('sends null services when everything is selected', () => {
    const input = buildCreateInput(form())
    expect(input.name).toBe('fix-auth')
    expect(input.options?.services).toBeNull()
    expect(input.provision).toBe(true)
    expect(input.autoStart).toBe(true)
  })

  it('sends the selection in canopy.yaml order when it is partial', () => {
    expect(buildCreateInput(form({ selectedServices: ['worker', 'api'] })).options?.services).toEqual(['api', 'worker'])
  })

  it('drops blank env rows and trims keys', () => {
    const env = [
      { key: '  API_URL ', value: 'http://x' },
      { key: '   ', value: 'ignored' },
      { key: 'TOKEN', value: 's3cret', secret: true }
    ]
    expect(buildCreateInput(form({ env })).options?.env).toEqual([
      { key: 'API_URL', value: 'http://x' },
      { key: 'TOKEN', value: 's3cret', secret: true }
    ])
  })

  it('carries the per-worktree overrides through', () => {
    const input = buildCreateInput(
      form({
        provision: false,
        autoStart: false,
        dbSource: { fromWorktree: 'wt-9' },
        caches: { node_modules: 'fresh' },
        cacheSource: { fromWorktree: 'wt-9' },
        skipSetup: true,
        runtime: 'docker'
      })
    )
    expect(input.options).toMatchObject({
      dbSource: { fromWorktree: 'wt-9' },
      caches: { node_modules: 'fresh' },
      cacheSource: { fromWorktree: 'wt-9' },
      skipSetup: true,
      runtime: 'docker'
    })
    expect(input.provision).toBe(false)
    expect(input.autoStart).toBe(false)
  })

  it('keeps the branch spec verbatim', () => {
    expect(buildCreateInput(form({ branch: { mode: 'existing', name: 'feat/x' } })).branch).toEqual({ mode: 'existing', name: 'feat/x' })
  })
})

describe('suggestWorktreeName', () => {
  it('slugifies the last branch segment', () => {
    expect(suggestWorktreeName('feat/Fix Auth')).toBe('fix-auth')
    expect(suggestWorktreeName('igaurab/feat/v2.1')).toBe('v2.1')
    expect(suggestWorktreeName('')).toBe('')
  })
})
