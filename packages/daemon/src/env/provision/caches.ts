/**
 * Cache directories (node_modules, .venv, target, .next, …) travel from a source checkout to a
 * new worktree by strategy: copy-on-write clone where the filesystem supports it (APFS
 * clonefile, Linux reflink), plain copy, symlink, or nothing. Also detects which ecosystems'
 * lockfiles differ between source and worktree so setup can reinstall.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { execa } from 'execa'
import picomatch from 'picomatch'

import { ECOSYSTEM_LOCKFILES, type CacheResult, type CacheRule, type CacheStrategy, type Ecosystem } from '@canopy/shared'

import type { LogSink } from '../types'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'target', 'dist', 'build', '.next', '.turbo', '__pycache__'])

/**
 * Directories under `root` matching a glob such as `node_modules`, `packages/*&#47;node_modules` or
 * `apps/**&#47;.next`. Walks at most `depth` levels and never descends into cache dirs themselves,
 * so a monorepo with thousands of files stays cheap.
 */
export function expandDirGlob(root: string, pattern: string, depth = 4): string[] {
  if (!pattern.includes('*')) return existsSync(join(root, pattern)) ? [pattern] : []
  const isMatch = picomatch(pattern, { dot: true })
  const found: string[] = []
  const walk = (dir: string, level: number): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const rel = relative(root, join(dir, entry.name))
      if (isMatch(rel)) {
        found.push(rel)
        continue
      }
      if (SKIP_DIRS.has(entry.name) || level >= depth) continue
      walk(join(dir, entry.name), level + 1)
    }
  }
  walk(root, 1)
  return found.sort()
}

/** Cache rules present in `root` (globs expanded), for the settings UI and the create form. */
export function detectCaches(root: string, rules: CacheRule[]): CacheRule[] {
  const seen = new Set<string>()
  const detected: CacheRule[] = []
  for (const rule of rules) {
    for (const path of expandDirGlob(root, rule.path)) {
      if (seen.has(path)) continue
      seen.add(path)
      detected.push({ ...rule, path, detected: true })
    }
  }
  return detected
}

async function cloneDir(source: string, target: string): Promise<'cloned' | 'copied'> {
  mkdirSync(dirname(target), { recursive: true })
  if (platform() === 'darwin') {
    // APFS clonefile: instant and shares blocks until written. Fails on non-APFS volumes.
    const clone = await execa('cp', ['-c', '-R', source, target], { reject: false })
    if (clone.exitCode === 0) return 'cloned'
  } else if (platform() === 'linux') {
    const clone = await execa('cp', ['-a', '--reflink=always', source, target], { reject: false })
    if (clone.exitCode === 0) return 'cloned'
  }
  await execa('cp', ['-R', '-p', source, target])
  return 'copied'
}

export interface LinkCachesInput {
  sourceRoot: string
  targetRoot: string
  rules: CacheRule[]
  /** Per-path overrides from the worktree options. */
  overrides: Record<string, CacheStrategy>
  logs: LogSink
  signal?: AbortSignal
}

/** Applies every cache rule; never throws for one failing directory (records `failed`). */
const fileHash = (path: string): string | null => {
  try {
    if (!statSync(path).isFile()) return null
    return createHash('sha1').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

export function changedLockfiles(sourceRoot: string, targetRoot: string, ecosystems: Ecosystem[]): Ecosystem[] {
  const changed: Ecosystem[] = []
  for (const ecosystem of new Set(ecosystems)) {
    for (const lockfile of ECOSYSTEM_LOCKFILES[ecosystem]) {
      const a = fileHash(join(sourceRoot, lockfile))
      const b = fileHash(join(targetRoot, lockfile))
      if (a === null && b === null) continue
      if (a !== b) {
        changed.push(ecosystem)
        break
      }
    }
  }
  return changed
}

/** The install command that refreshes a cloned cache after its lockfile changed. */
export function installCommand(root: string, ecosystem: Ecosystem): string | null {
  const has = (file: string): boolean => existsSync(join(root, file))
  switch (ecosystem) {
    case 'node':
      if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile'
      if (has('yarn.lock')) return 'yarn install --frozen-lockfile'
      if (has('bun.lockb') || has('bun.lock')) return 'bun install --frozen-lockfile'
      return has('package-lock.json') ? 'npm ci' : 'npm install'
    case 'python':
      if (has('uv.lock') || has('pyproject.toml')) return 'uv sync'
      if (has('requirements.txt')) return 'uv pip install -r requirements.txt'
      return null
    case 'rust':
      return 'cargo fetch'
    case 'go':
      return 'go mod download'
    default:
      return null
  }
}

/** Env that points package managers at machine-wide stores so fresh installs hardlink instead of download. */
export const SHARED_STORE_ENV: Record<string, string> = {
  UV_LINK_MODE: 'hardlink',
  npm_config_prefer_offline: 'true'
}
