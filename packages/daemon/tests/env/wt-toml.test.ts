import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CANOPY_HOOK_COMMANDS, defaultProjectSettings, type WorktrunkSettings } from '@canopy/shared'

import { CANOPY_TOML_HEADER, readWtToml, renderWtToml, writeWtToml } from '../../src/env/settings/wt-toml'

const settings = (patch: Partial<WorktrunkSettings> = {}): WorktrunkSettings => ({ ...defaultProjectSettings().worktrunk, ...patch })

describe('wt.toml writer', () => {
  it('writes canopy hooks into a fresh file', () => {
    const text = renderWtToml(null, settings())
    expect(text.startsWith(`${CANOPY_TOML_HEADER}\n`)).toBe(true)
    const doc = parse(text) as Record<string, Record<string, string>>
    expect(doc['post-start']).toEqual({ canopy: CANOPY_HOOK_COMMANDS.provision })
    expect(doc['pre-remove']).toEqual({ canopy: CANOPY_HOOK_COMMANDS.teardown })
    expect(doc['list']).toBeUndefined()
  })

  it('preserves user content and replaces canopy hooks instead of duplicating them', () => {
    const existing = [
      'default_branch = "main"',
      '',
      '[post-start]',
      'install = "npm ci"',
      'canopy = "canopy provision --path {{ worktree_path }}"',
      '',
      '[list]',
      'full = true',
      'url = "https://old.example/{{ branch }}"',
      ''
    ].join('\n')

    const once = renderWtToml(existing, settings({ listUrl: 'https://ci.example/{{ branch }}' }))
    const twice = renderWtToml(once, settings({ listUrl: 'https://ci.example/{{ branch }}' }))
    expect(twice).toBe(once)

    const doc = parse(once) as Record<string, unknown>
    expect(doc['default_branch']).toBe('main')
    expect(doc['post-start']).toEqual({ install: 'npm ci', canopy: CANOPY_HOOK_COMMANDS.provision })
    expect(doc['list']).toEqual({ full: true, url: 'https://ci.example/{{ branch }}' })
    // Exactly one header, exactly one canopy entry.
    expect(once.split(CANOPY_TOML_HEADER)).toHaveLength(2)
    expect(once.split('canopy provision')).toHaveLength(2)
  })

  it('adds and removes list.url without touching the rest of [list]', () => {
    const withUrl = renderWtToml('[list]\nfull = true\n', settings({ listUrl: 'https://x/{{ branch }}' }))
    expect((parse(withUrl) as { list: Record<string, unknown> }).list).toEqual({ full: true, url: 'https://x/{{ branch }}' })

    const withoutUrl = renderWtToml(withUrl, settings({ listUrl: '' }))
    expect((parse(withoutUrl) as { list: Record<string, unknown> }).list).toEqual({ full: true })

    const dropped = renderWtToml('[list]\nurl = "https://x"\n', settings({ listUrl: '' }))
    expect((parse(dropped) as Record<string, unknown>)['list']).toBeUndefined()
  })

  it('drops hooks that settings no longer declare and keeps unrelated ones', () => {
    const existing = ['[pre-remove]', 'canopy = "canopy teardown --path {{ worktree_path }}"', '', '[post-remove]', 'notify = "say bye"', ''].join('\n')
    const text = renderWtToml(existing, settings({ hooks: [] }))
    const doc = parse(text) as Record<string, unknown>
    expect(doc['pre-remove']).toBeUndefined()
    expect(doc['post-remove']).toEqual({ notify: 'say bye' })
  })

  it('writes a lone unnamed rule as a string, and names it when the hook has company', () => {
    const single = renderWtToml(null, settings({ hooks: [{ hook: 'pre-start', command: 'npm ci' }] }))
    expect((parse(single) as Record<string, unknown>)['pre-start']).toBe('npm ci')

    const shared = renderWtToml('pre-start = "make deps"\n', settings({ hooks: [{ hook: 'pre-start', command: 'npm ci' }] }))
    expect((parse(shared) as Record<string, unknown>)['pre-start']).toEqual({ default: 'make deps', 'canopy-1': 'npm ci' })
  })

  it('appends to a [[hook]] pipeline instead of flattening it', () => {
    const existing = ['[[post-start]]', 'install = "npm ci"', '', '[[post-start]]', 'server = "npm run dev"', ''].join('\n')
    const text = renderWtToml(existing, settings({ hooks: [{ hook: 'post-start', name: 'canopy', command: CANOPY_HOOK_COMMANDS.provision }] }))
    expect((parse(text) as Record<string, unknown>)['post-start']).toEqual([
      { install: 'npm ci' },
      { server: 'npm run dev' },
      { canopy: CANOPY_HOOK_COMMANDS.provision }
    ])
  })
})

describe('wt.toml files', () => {
  let repoPath: string
  beforeEach(() => {
    repoPath = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-wttoml-')))
  })
  afterEach(() => rmSync(repoPath, { recursive: true, force: true }))

  it('reads null when absent and creates .config/ on write', () => {
    expect(readWtToml(repoPath)).toBeNull()
    const path = writeWtToml(repoPath, renderWtToml(null, settings()))
    expect(path).toBe(join(repoPath, '.config', 'wt.toml'))
    expect(readFileSync(path, 'utf8')).toContain('canopy provision')
    expect(readWtToml(repoPath)).toBe(readFileSync(path, 'utf8'))
  })
})
