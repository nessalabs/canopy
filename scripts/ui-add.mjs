#!/usr/bin/env node
// Local-first wrapper around `shadcn add` for the Canopy monorepo.
//
// Components land in packages/ui/src/components/ui (vendored copies — see docs/todo.md:
// they are to be replaced by `@nessa-ui/react` imports once that package is published).
//
// Component resolution, per argument:
//   button                        -> ../nessa_ui/public/r/button.json when the local
//                                    checkout has it, else GitHub (nessalabs/nessa_ui/button)
//   nessalabs/nessa_ui/button     -> same local-first resolution
//   ./some/item.json, https://…   -> passed through untouched
//
// Flags:
//   --remote      skip the local checkout entirely, install from GitHub main
//   --no-build    don't regenerate the local registry before installing
//   --overwrite   let shadcn overwrite files that already exist
//
// Local registry items still reference their deps as "nessalabs/nessa_ui/<dep>", which
// shadcn would fetch from GitHub main — a 404 for a dep that is also new. So local items
// are copied to a temp dir with those references rewritten to local paths, recursively.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM = 'nessalabs/nessa_ui'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uiRoot = join(repoRoot, 'packages', 'ui')
const nessaUiDir = resolve(process.env.NESSA_UI_DIR ?? join(repoRoot, '..', 'nessa_ui'))
const localRegistryDir = join(nessaUiDir, 'public', 'r')

const KNOWN_FLAGS = new Set(['--remote', '--no-build', '--overwrite'])
const flags = new Set(process.argv.slice(2).filter((arg) => KNOWN_FLAGS.has(arg)))
const requested = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.has(arg))

if (requested.length === 0) {
  console.error('usage: npm run ui:add -- <component ...> [--remote] [--no-build] [--overwrite]')
  process.exit(1)
}

const useLocal = !flags.has('--remote') && existsSync(localRegistryDir)

if (useLocal && !flags.has('--no-build')) {
  console.log(`rebuilding registry in ${nessaUiDir} ...`)
  const build = spawnSync('npx', ['--yes', 'pnpm@11.9.0', 'build:registry'], { cwd: nessaUiDir, stdio: 'inherit' })
  if (build.status !== 0) {
    console.error('registry build failed — run `pnpm install --frozen-lockfile` in the checkout, or pass --no-build.')
    process.exit(build.status ?? 1)
  }
}

function componentName(arg) {
  if (arg.startsWith(`${UPSTREAM}/`)) return arg.slice(UPSTREAM.length + 1)
  return /^[a-z0-9-]+$/.test(arg) ? arg : null
}

const tempDir = mkdtempSync(join(tmpdir(), 'nessa-ui-add-'))
const materialized = new Map()
function materialize(name) {
  if (materialized.has(name)) return materialized.get(name)
  const source = join(localRegistryDir, `${name}.json`)
  if (!existsSync(source)) return null
  const target = join(tempDir, `${name}.json`)
  materialized.set(name, target)
  const item = JSON.parse(readFileSync(source, 'utf8'))
  item.registryDependencies = (item.registryDependencies ?? []).map((dep) => {
    const depName = componentName(dep)
    return depName ? materialize(depName) ?? `${UPSTREAM}/${depName}` : dep
  })
  writeFileSync(target, JSON.stringify(item, null, 2))
  return target
}

function resolveArg(arg) {
  const name = componentName(arg)
  if (!name) return arg
  const local = useLocal ? materialize(name) : null
  console.log(`${name}: ${local ? 'installing from local checkout' : `installing from ${UPSTREAM}`}`)
  return local ?? `${UPSTREAM}/${name}`
}

const shadcnArgs = ['add', ...requested.map(resolveArg), '--yes', ...(flags.has('--overwrite') ? ['--overwrite'] : [])]
const result = spawnSync('npx', ['--yes', 'shadcn@latest', ...shadcnArgs], { cwd: uiRoot, stdio: 'inherit' })
rmSync(tempDir, { recursive: true, force: true })
if (result.status !== 0) process.exit(result.status ?? 1)

// shadcn rewrites `@/components/split-view` (a directory index) to `.../split-view/split-view`,
// which does not export the panel/separator members. Undo that so re-vendoring stays clean.
const IMPORT_FIXUPS = [[/@\/components\/split-view\/split-view"/g, '@/components/split-view"']]
function applyFixups(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) applyFixups(path)
    else if (/\.tsx?$/.test(entry.name)) {
      const before = readFileSync(path, 'utf8')
      const after = IMPORT_FIXUPS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), before)
      if (after !== before) writeFileSync(path, after)
    }
  }
}
applyFixups(join(uiRoot, 'src', 'components'))

// Safety net: shadcn falls back to <cwd>/components when it can't detect a framework.
for (const dir of ['components', 'lib', 'hooks']) {
  const stray = join(uiRoot, dir)
  if (!existsSync(stray)) continue
  cpSync(stray, join(uiRoot, 'src', dir), { recursive: true, force: true })
  rmSync(stray, { recursive: true, force: true })
  console.log(`moved packages/ui/${dir} -> packages/ui/src/${dir}`)
}
