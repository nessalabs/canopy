/**
 * Reads and caches `canopy.yaml`.
 *
 * Three subtleties drive the shape. First, the worktree's own copy wins but a branch cut
 * before the file existed must still run: the project's primary checkout is the fallback, so
 * `git switch`ing to an old branch does not un-configure the environment. Second, a repo that
 * should not carry a canopy.yaml at all can keep one in the project's Canopy home
 * (`~/.canopy/<project>/canopy.yaml`) — searched last, so a committed file always wins and
 * nothing about an already-configured project changes. Third, this is called on every
 * environment read (the dashboard polls), so a file that has not changed is never parsed
 * twice — the cache key is path + mtime + size.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { type CanopyConfig, type CanopyYamlParse, type CanopyYamlReport, parseCanopyYaml, reportFor } from '@canopy/shared'

/** `.yaml` first; `.yml` is accepted because half the world writes it that way. */
const FILE_NAMES = ['canopy.yaml', 'canopy.yml'] as const

export interface LoadedConfig {
  /** Absolute path of the file in effect, or null when neither location has one. */
  path: string | null
  raw: string | null
  parsed: CanopyYamlParse | null
  /** Non-null only when the file parses *and* lints clean. */
  config: CanopyConfig | null
  report: CanopyYamlReport
}

interface CacheEntry {
  mtimeMs: number
  size: number
  loaded: LoadedConfig
}

const cache = new Map<string, CacheEntry>()

const MISSING: LoadedConfig = { path: null, raw: null, parsed: null, config: null, report: reportFor(null) }

/** The canopy.yaml/canopy.yml a directory holds, or null. */
function findFile(dir: string): string | null {
  for (const name of FILE_NAMES) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return null
}

function loadFile(path: string): LoadedConfig {
  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(path)
  } catch {
    return MISSING
  }
  const cached = cache.get(path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.loaded
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return MISSING
  }
  const parsed = parseCanopyYaml(raw)
  const loaded: LoadedConfig = { path, raw, parsed, config: parsed.config, report: reportFor(parsed) }
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, loaded })
  return loaded
}

/**
 * @param worktreePath the checkout whose config is wanted.
 * @param fallbackPath the project's primary checkout, used when the worktree has no file.
 * @param homePath the project's Canopy home (`~/.canopy/<project>`), used when neither checkout has one.
 */
export function loadCanopyConfig(worktreePath: string, fallbackPath?: string, homePath?: string): LoadedConfig {
  const dirs = [worktreePath, fallbackPath, homePath].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const found = findFile(dir)
    if (found) return loadFile(found)
  }
  return MISSING
}

/** Drops memoised parses; for tests and for an explicit "reload config" action. */
export function clearConfigCache(): void {
  cache.clear()
}
