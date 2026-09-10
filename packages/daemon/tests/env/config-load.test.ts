import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearConfigCache, loadCanopyConfig } from '../../src/env/config/load'

const YAML = (port: string): string => `version: 1\nports:\n  ${port}: {}\nservices:\n  web:\n    run: npm run dev -- --port \${ports.${port}}\n`

describe('canopy.yaml loading', () => {
  let root: string
  let primary: string
  let worktree: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-cfg-')))
    primary = join(root, 'primary')
    worktree = join(root, 'branch')
    mkdirSync(primary)
    mkdirSync(worktree)
    clearConfigCache()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reports nothing when neither location has a file', () => {
    const loaded = loadCanopyConfig(worktree, primary)
    expect(loaded).toMatchObject({ path: null, raw: null, parsed: null, config: null })
    expect(loaded.report).toMatchObject({ present: false, valid: false })
  })

  it("prefers the worktree's own file and falls back to the primary checkout", () => {
    writeFileSync(join(primary, 'canopy.yaml'), YAML('web'))
    const fallback = loadCanopyConfig(worktree, primary)
    expect(fallback.path).toBe(join(primary, 'canopy.yaml'))
    expect(Object.keys(fallback.config?.ports ?? {})).toEqual(['web'])

    writeFileSync(join(worktree, 'canopy.yaml'), YAML('api'))
    const own = loadCanopyConfig(worktree, primary)
    expect(own.path).toBe(join(worktree, 'canopy.yaml'))
    expect(Object.keys(own.config?.ports ?? {})).toEqual(['api'])
  })

  it('falls back to the project home last, behind both checkouts', () => {
    const home = join(root, 'home')
    mkdirSync(home)
    writeFileSync(join(home, 'canopy.yaml'), YAML('home'))
    expect(loadCanopyConfig(worktree, primary, home).path).toBe(join(home, 'canopy.yaml'))

    writeFileSync(join(primary, 'canopy.yaml'), YAML('web'))
    expect(loadCanopyConfig(worktree, primary, home).path).toBe(join(primary, 'canopy.yaml'))

    writeFileSync(join(worktree, 'canopy.yaml'), YAML('api'))
    expect(loadCanopyConfig(worktree, primary, home).path).toBe(join(worktree, 'canopy.yaml'))
  })

  it('accepts canopy.yml too', () => {
    writeFileSync(join(worktree, 'canopy.yml'), YAML('web'))
    expect(loadCanopyConfig(worktree).path).toBe(join(worktree, 'canopy.yml'))
  })

  it('caches by mtime and size, and re-reads when the file changes', () => {
    const path = join(worktree, 'canopy.yaml')
    writeFileSync(path, YAML('web'))
    const first = loadCanopyConfig(worktree)
    expect(loadCanopyConfig(worktree)).toBe(first)

    writeFileSync(path, YAML('api'), { flush: true })
    const second = loadCanopyConfig(worktree)
    expect(second).not.toBe(first)
    expect(Object.keys(second.config?.ports ?? {})).toEqual(['api'])

    unlinkSync(path)
    expect(loadCanopyConfig(worktree).path).toBeNull()
  })

  it('surfaces lint errors without a config', () => {
    writeFileSync(join(worktree, 'canopy.yaml'), 'version: 1\nservices:\n  web:\n    run: echo ${ports.nope}\n')
    const loaded = loadCanopyConfig(worktree)
    expect(loaded.config).toBeNull()
    expect(loaded.report.valid).toBe(false)
    expect(loaded.report.errors.join(' ')).toContain('unknown port')
  })
})
