import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { EMPTY_REPORT, parseCanopyYaml, reportFor, type CanopyYamlReport, type ComposeInfo, type Ecosystem, type ScanResult } from '@canopy/shared'

import type { Repo } from '../git/repo'
import { badRequest } from '../lib/errors'

/** Marker file → ecosystem. Order matters only for display. */
const ECOSYSTEM_MARKERS: Record<string, Ecosystem> = {
  'package.json': 'node',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'rust'
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

function detectEcosystems(root: string, compose: ComposeInfo | undefined): Ecosystem[] {
  const found = Object.entries(ECOSYSTEM_MARKERS)
    .filter(([marker]) => existsSync(join(root, marker)))
    .map(([, ecosystem]) => ecosystem)
  return [...new Set([...found, ...(compose ? ['docker-compose' as const] : [])])]
}

function detectCompose(root: string): ComposeInfo | undefined {
  const file = COMPOSE_FILES.find((name) => existsSync(join(root, name)))
  if (!file) return undefined
  const doc = parseYaml(readFileSync(join(root, file), 'utf8')) as { services?: Record<string, unknown> } | null
  return { file, services: Object.keys(doc?.services ?? {}) }
}

export function readCanopyYaml(root: string): { report: CanopyYamlReport; raw: string | null } {
  const path = ['canopy.yaml', 'canopy.yml'].map((name) => join(root, name)).find((candidate) => existsSync(candidate))
  if (!path) return { report: EMPTY_REPORT, raw: null }
  const raw = readFileSync(path, 'utf8')
  return { report: reportFor(parseCanopyYaml(raw)), raw }
}

/** Everything the Add-project dialog shows before the user commits to registering. */
export async function scanRepo(repo: Repo, path: string): Promise<ScanResult> {
  const root = await repo.toplevel(path)
  if (!root) throw badRequest('not_a_git_repo', `${path} is not inside a git repository`)
  const branches = await repo.listBranches(root)
  const compose = detectCompose(root)
  return {
    path: root,
    name: basename(root),
    defaultBranch: await repo.defaultBranch(root, branches),
    branches,
    canopyYaml: readCanopyYaml(root).report,
    ecosystems: detectEcosystems(root, compose),
    compose
  }
}
