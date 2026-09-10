import type { Database } from 'better-sqlite3'

import { defaultProjectSettings, type AddProjectInput, type Branch, type ComposeInfo, type Ecosystem, type Project, type ScanResult, type UpdateProjectInput } from '@canopy/shared'

import { projectHome } from '../config'
import { loadCanopyConfig } from '../env/config/load'
import type { Repo } from '../git/repo'
import { conflict, notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import { readCanopyYaml, scanRepo } from './scan'

interface ProjectRow {
  id: string
  name: string
  path: string
  default_base: string
  config_yaml: string | null
  detected_json: string
  created_at: number
}

interface Detected {
  ecosystems: Ecosystem[]
  compose?: ComposeInfo
}

function toProject(row: ProjectRow, home: string): Project {
  const detected = JSON.parse(row.detected_json) as Detected
  // Re-read (mtime-cached) so edits made outside Canopy show up without re-registering.
  const config = loadCanopyConfig(row.path, undefined, projectHome(home, row.name)).report
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    defaultBase: row.default_base,
    hasCanopyYaml: config.present,
    config,
    ecosystems: detected.ecosystems,
    compose: detected.compose,
    createdAt: row.created_at
  }
}

export class ProjectsService {
  constructor(
    private readonly db: Database,
    private readonly repo: Repo,
    /** Canopy home; a project's canopy.yaml may live under `<home>/<project>/` instead of in the repo. */
    private readonly home: string
  ) {}

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[]).map((row) => toProject(row, this.home))
  }

  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!row) throw notFound('project', id)
    return toProject(row, this.home)
  }

  scan(path: string): Promise<ScanResult> {
    return scanRepo(this.repo, path)
  }

  async add(input: AddProjectInput): Promise<Project> {
    const scan = await this.scan(input.path)
    const existing = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(scan.path) as { id: string } | undefined
    if (existing) throw conflict('project_exists', `${scan.path} is already registered`, { id: existing.id })

    const id = newId()
    const at = now()
    const detected: Detected = { ecosystems: scan.ecosystems, compose: scan.compose }
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, default_base, config_yaml, detected_json, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name ?? scan.name, scan.path, input.defaultBase ?? scan.defaultBranch, readCanopyYaml(scan.path).raw, JSON.stringify(detected), JSON.stringify(defaultProjectSettings(scan.ecosystems)), at, at)
    return this.get(id)
  }

  /** Keeps the stored copy of canopy.yaml current after the settings editor writes it. */
  rememberConfig(id: string, raw: string): void {
    this.db.prepare('UPDATE projects SET config_yaml = ?, updated_at = ? WHERE id = ?').run(raw, now(), id)
  }

  update(id: string, patch: UpdateProjectInput): Project {
    const current = this.get(id)
    this.db
      .prepare('UPDATE projects SET name = ?, default_base = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? current.name, patch.defaultBase ?? current.defaultBase, now(), id)
    return this.get(id)
  }

  remove(id: string): void {
    this.get(id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  async branches(id: string): Promise<{ branches: Branch[]; defaultBranch: string }> {
    const project = this.get(id)
    const branches = await this.repo.listBranches(project.path)
    return { branches, defaultBranch: project.defaultBase }
  }
}
