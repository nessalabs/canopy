/**
 * Canopy's per-project preferences (`projects.settings_json`). Nothing here is committed —
 * it is how *this machine* wants worktrees of this project made — so the store is one JSON
 * blob rather than columns: the shape changes with the UI, and a blob plus a merge over the
 * current defaults means an older row keeps working when a new key appears.
 */
import type { Database } from 'better-sqlite3'

import { defaultProjectSettings, type Ecosystem, ProjectSettings } from '@canopy/shared'

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Stored values win, but only key by key: arrays replace, unknown keys keep their default. */
function mergeOverDefaults(defaults: ProjectSettings, stored: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(defaults as unknown as Record<string, unknown>) }
  for (const [key, value] of Object.entries(stored)) {
    const base = merged[key]
    merged[key] = isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value
  }
  return merged
}

/**
 * Settings for a project, defaulted from its detected ecosystems (cache rules differ between
 * a node repo and a rust one). Anything unparseable falls back to the defaults rather than
 * failing the request — settings are a preference, never a reason to break the dashboard.
 */
export function loadProjectSettings(db: Database, projectId: string, ecosystems: Ecosystem[]): ProjectSettings {
  const defaults = defaultProjectSettings(ecosystems)
  const row = db.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as { settings_json: string | null } | undefined
  if (!row?.settings_json) return defaults
  let stored: unknown
  try {
    stored = JSON.parse(row.settings_json)
  } catch {
    return defaults
  }
  if (!isPlainObject(stored)) return defaults
  const parsed = ProjectSettings.safeParse(mergeOverDefaults(defaults, stored))
  return parsed.success ? parsed.data : defaults
}

/** Writes the whole object back; `updated_at` moves so pollers notice. */
export function saveProjectSettings(db: Database, projectId: string, settings: ProjectSettings): void {
  db.prepare('UPDATE projects SET settings_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), Date.now(), projectId)
}
