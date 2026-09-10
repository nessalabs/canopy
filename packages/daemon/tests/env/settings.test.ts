import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultAppSettings, defaultProjectSettings } from '@canopy/shared'

import { openDb, type Database } from '../../src/db'
import { loadAppSettings, saveAppSettings } from '../../src/env/settings/app-settings'
import { loadProjectSettings, saveProjectSettings } from '../../src/env/settings/project-settings'

describe('project settings', () => {
  let db: Database
  beforeEach(() => {
    db = openDb(':memory:')
    db.prepare('INSERT INTO projects (id, name, path, default_base, detected_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
      'p1',
      'proj',
      '/tmp/proj',
      'main',
      '{}',
      0,
      0
    )
  })
  afterEach(() => db.close())

  it('defaults from the project ecosystems when nothing is stored', () => {
    expect(loadProjectSettings(db, 'p1', ['node'])).toEqual(defaultProjectSettings(['node']))
    expect(loadProjectSettings(db, 'p1', []).caches.rules).toEqual([])
    expect(loadProjectSettings(db, 'p1', ['node']).caches.rules.some((rule) => rule.path === 'node_modules')).toBe(true)
  })

  it('round-trips and bumps updated_at', () => {
    const settings = defaultProjectSettings(['rust'])
    settings.autoFetch = false
    settings.worktrunk.worktreePath = '{{ repo_path }}/../{{ name }}'
    saveProjectSettings(db, 'p1', settings)

    expect(loadProjectSettings(db, 'p1', ['rust'])).toEqual(settings)
    expect((db.prepare('SELECT updated_at FROM projects WHERE id = ?').get('p1') as { updated_at: number }).updated_at).toBeGreaterThan(0)
  })

  it('merges a partial stored blob over the current defaults', () => {
    db.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({ autoFetch: false, cleanup: { staleDays: 3 } }), 'p1')
    const loaded = loadProjectSettings(db, 'p1', ['node'])
    expect(loaded.autoFetch).toBe(false)
    expect(loaded.cleanup.staleDays).toBe(3)
    // Keys the stored blob never heard of still come from the defaults.
    expect(loaded.cleanup.dirtyDestroy).toBe('prompt')
    expect(loaded.worktrunk.hooks).toEqual(defaultProjectSettings().worktrunk.hooks)
  })

  it('falls back to defaults for corrupt or invalid json', () => {
    db.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run('{not json', 'p1')
    expect(loadProjectSettings(db, 'p1', [])).toEqual(defaultProjectSettings([]))
    db.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({ autoFetchInterval: 'never' }), 'p1')
    expect(loadProjectSettings(db, 'p1', [])).toEqual(defaultProjectSettings([]))
  })
})

describe('app settings', () => {
  let home: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-app-')))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('defaults when config.json has no app key', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 9483, host: '127.0.0.1' }))
    expect(loadAppSettings(home)).toEqual(defaultAppSettings())
  })

  it('round-trips and preserves the daemon keys of config.json', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 9483, host: '127.0.0.1', worktreeRoot: '~/code/wt' }))
    const settings = defaultAppSettings()
    settings.editor = { id: 'zed', command: 'zed {path}' }
    settings.ports = { from: 41000, to: 41999 }
    saveAppSettings(home, settings)

    expect(loadAppSettings(home)).toEqual(settings)
    const file = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(file['port']).toBe(9483)
    expect(file['worktreeRoot']).toBe('~/code/wt')
  })

  it('merges a partial app blob over the defaults and survives corruption', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ app: { diff: { wrap: true } } }))
    const loaded = loadAppSettings(home)
    expect(loaded.diff).toEqual({ layout: 'split', wrap: true, lineNumbers: true })
    expect(loaded.editor).toEqual(defaultAppSettings().editor)

    writeFileSync(join(home, 'config.json'), 'not json at all')
    expect(loadAppSettings(home)).toEqual(defaultAppSettings())
  })
})
