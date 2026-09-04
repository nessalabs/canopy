#!/usr/bin/env node
// Vendors nessa_ui's `agent-stream` registry item into packages/shared/src/agent-stream.
//
// Why not `npm run ui:add`: that script targets packages/ui (shadcn needs its components.json),
// cannot filter files, and agent-stream is pure TypeScript the daemon needs too — so it lives in
// @canopy/shared and is exposed as the `@canopy/shared/agent-stream` subpath.
//
// Only the providers Canopy drives are copied (Claude stream-json via the Agent SDK, Codex
// app-server) plus the shared core and the transcript fold. nessa's own barrels (`index.ts`,
// `contract.ts`, `transports.ts`, `claude/index.ts`, `codex/index.ts`) reference the dropped
// providers, so Canopy keeps its own barrel at packages/shared/src/agent-stream/index.ts — the one
// file in that directory that is not vendored.
//
//   node scripts/vendor-agent-stream.mjs            # from ../nessa_ui (or $NESSA_UI_DIR)
//
// Never edit vendored files by hand; re-run this and fix the barrel instead.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nessaUiDir = resolve(process.env.NESSA_UI_DIR ?? join(repoRoot, '..', 'nessa_ui'))
const registryItem = join(nessaUiDir, 'public', 'r', 'agent-stream.json')
const destDir = join(repoRoot, 'packages', 'shared', 'src', 'agent-stream')
const TARGET_PREFIX = 'lib/agent-stream/'
const BARREL = 'index.ts'

/** Paths (relative to the item's `lib/agent-stream/` target) Canopy keeps. */
const KEEP = [
  'events.ts',
  'json.ts',
  'emitter.ts',
  'capabilities.ts',
  'mapping.ts',
  'claude/tools.ts',
  'claude/stream/',
  'codex/app-server/',
  'transcript/'
]

if (!existsSync(registryItem)) {
  console.error(`✗ ${registryItem} not found — clone nessa_ui next to canopy or set NESSA_UI_DIR`)
  process.exit(1)
}

const item = JSON.parse(readFileSync(registryItem, 'utf8'))
const files = item.files
  .filter((file) => file.target?.startsWith(TARGET_PREFIX))
  .map((file) => ({ rel: file.target.slice(TARGET_PREFIX.length), content: file.content }))
  .filter(({ rel }) => KEEP.some((prefix) => (prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix)))
  .sort((a, b) => a.rel.localeCompare(b.rel))

if (files.length === 0) {
  console.error('✗ registry item matched no files — has the registry layout changed?')
  process.exit(1)
}

// Wipe previously vendored files (everything except Canopy's barrel) so removals upstream propagate.
if (existsSync(destDir)) {
  for (const entry of readdirSync(destDir)) {
    if (entry === BARREL || entry === 'VENDORED.md') continue
    rmSync(join(destDir, entry), { recursive: true, force: true })
  }
}

for (const { rel, content } of files) {
  const out = join(destDir, rel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, content)
}

const nessaCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: nessaUiDir, encoding: 'utf8' }).trim()
const nessaBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: nessaUiDir, encoding: 'utf8' }).trim()
const manifest = [
  '# Vendored: @nessa-ui/agent-stream',
  '',
  `Source: nessalabs/nessa_ui \`${nessaBranch}\` @ \`${nessaCommit}\` (registry item \`agent-stream\`, \`packages/agent-stream/src\`).`,
  `Vendored on ${new Date().toISOString().slice(0, 10)} with \`node scripts/vendor-agent-stream.mjs\`.`,
  '',
  'Do not edit these files by hand. Re-run the script; Canopy-specific glue lives in `index.ts` (the',
  'barrel, not vendored) and in the daemon/UI code that consumes it.',
  '',
  'Kept (Claude stream-json + Codex app-server + core + transcript fold); acp, cursor, opencode and',
  "Codex `exec --json` are not copied, nor are nessa's own barrels that reference them.",
  '',
  ...files.map(({ rel }) => `- ${rel}`),
  ''
].join('\n')
writeFileSync(join(destDir, 'VENDORED.md'), manifest)

const bytes = files.reduce((sum, { content }) => sum + Buffer.byteLength(content), 0)
console.log(`✓ vendored ${files.length} files (${(bytes / 1024).toFixed(0)} KiB) from nessa_ui ${nessaBranch}@${nessaCommit.slice(0, 7)} → ${destDir}`)
if (!existsSync(join(destDir, BARREL))) {
  console.warn(`! ${join(destDir, BARREL)} is missing — Canopy's barrel is not vendored; create it`)
}
