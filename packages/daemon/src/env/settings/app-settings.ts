/**
 * Machine-level settings (editor, terminal, diff preferences, port range). They live under
 * the `app` key of `~/.canopy/config.json` next to the daemon's own port/host/worktreeRoot
 * so a user has one file to edit and back up — which is also why every write must preserve
 * the keys `config.ts` owns.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AppSettings, defaultAppSettings } from '@canopy/shared'

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const configPath = (home: string): string => join(home, 'config.json')

/** The whole config.json, or an empty object when it is missing or corrupt. */
function readConfigFile(home: string): Record<string, unknown> {
  const path = configPath(home)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Stored values win key by key, so a settings file written by an older build still loads. */
function mergeOverDefaults(stored: Record<string, unknown>): Record<string, unknown> {
  const defaults = defaultAppSettings() as unknown as Record<string, unknown>
  const merged: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(stored)) {
    const base = merged[key]
    merged[key] = isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value
  }
  return merged
}

/** App settings from `<home>/config.json`; defaults when absent or invalid. */
export function loadAppSettings(home: string): AppSettings {
  const app = readConfigFile(home)['app']
  if (!isPlainObject(app)) return defaultAppSettings()
  const parsed = AppSettings.safeParse(mergeOverDefaults(app))
  return parsed.success ? parsed.data : defaultAppSettings()
}

/** Rewrites only the `app` key; port, host, worktreeRoot and dataRoot stay as they were. */
export function saveAppSettings(home: string, settings: AppSettings): void {
  mkdirSync(home, { recursive: true })
  const file = readConfigFile(home)
  writeFileSync(configPath(home), `${JSON.stringify({ ...file, app: settings }, null, 2)}\n`)
}
