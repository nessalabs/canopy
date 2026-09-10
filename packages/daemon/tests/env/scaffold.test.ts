import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Ecosystem, parseCanopyYaml, STARTER_CANOPY_YAML } from '@canopy/shared'

import { scaffoldCanopyYaml } from '../../src/env/config/scaffold'

describe('canopy.yaml scaffolding', () => {
  let repo: string
  const write = (files: Record<string, string>): void => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true })
      writeFileSync(join(repo, rel), content)
    }
  }
  /** Every generated file must be accepted by the daemon's own validator. */
  const scaffold = async (ecosystems: Ecosystem[], compose?: { file: string; services: string[] }): Promise<string> => {
    const text = await scaffoldCanopyYaml(repo, compose ? { ecosystems, compose } : { ecosystems })
    const parsed = parseCanopyYaml(text)
    expect(parsed.errors).toEqual([])
    expect(parsed.config).not.toBeNull()
    return text
  }

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-scaffold-')))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('falls back to the starter when nothing is detected', async () => {
    expect(await scaffoldCanopyYaml(repo, { ecosystems: [] })).toBe(STARTER_CANOPY_YAML)
  })

  it('detects a vite app and its package manager', async () => {
    write({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'pnpm-lock.yaml': '' })
    const text = await scaffold(['node'])
    expect(text).toContain('pnpm install --frozen-lockfile')
    expect(text).toContain('if_changed: [pnpm-lock.yaml]')
    expect(text).toContain('pnpm run dev -- --port ${ports.web}')
    const config = parseCanopyYaml(text).config!
    expect(Object.keys(config.ports)).toEqual(['web'])
    expect(config.services['web']?.health?.tcp).toBe('${ports.web}')
  })

  it('gives a non-vite script the port through the environment', async () => {
    write({ 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }), 'package-lock.json': '{}' })
    const text = await scaffold(['node'])
    expect(text).toContain('npm ci')
    expect(text).toContain('run: npm run start')
    expect(parseCanopyYaml(text).config?.services['web']?.env).toEqual({ PORT: '${ports.web}' })
  })

  it('detects Django, and a plain python entry point', async () => {
    write({ 'pyproject.toml': '[project]\nname = "app"\n', 'uv.lock': '', 'manage.py': '' })
    const django = await scaffold(['python'])
    expect(django).toContain('uv sync')
    expect(django).toContain('uv run python manage.py runserver 127.0.0.1:${ports.web}')

    rmSync(join(repo, 'manage.py'))
    write({ 'app.py': '' })
    expect(await scaffold(['python'])).toContain('uv run python app.py')
  })

  it('detects rust and go', async () => {
    write({ 'Cargo.toml': '[package]\nname = "app"\n', 'Cargo.lock': '' })
    const rust = await scaffold(['rust'])
    expect(rust).toContain('cargo build')
    expect(rust).toContain('run: cargo run')

    write({ 'go.mod': 'module app\n', 'go.sum': '' })
    const go = await scaffold(['go'])
    expect(go).toContain('go mod download')
    expect(go).toContain('run: go run .')
  })

  it('turns a compose file into a stack service and guesses its databases', async () => {
    write({ 'docker-compose.yml': 'services:\n  db: {}\n' })
    const text = await scaffold(['docker-compose'], { file: 'docker-compose.yml', services: ['db', 'cache-redis', 'web'] })
    const config = parseCanopyYaml(text).config!
    expect(config.services['stack']?.compose?.file).toBe('docker-compose.yml')
    expect(config.databases['main']).toMatchObject({ adapter: 'postgres', version: '16', env: 'DATABASE_URL' })
    expect(config.databases['cache-redis']).toMatchObject({ adapter: 'redis', env: 'REDIS_URL' })
    expect(text).toContain('${ports.x}')
  })

  it('combines several ecosystems without colliding on names or ports', async () => {
    write({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' } }), 'Cargo.toml': '[package]\nname = "api"\n' })
    const text = await scaffold(['node', 'rust'])
    const config = parseCanopyYaml(text).config!
    expect(Object.keys(config.services).sort()).toEqual(['app', 'web'])
    expect(Object.keys(config.ports).sort()).toEqual(['app', 'web'])
  })
})
