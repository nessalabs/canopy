#!/usr/bin/env node
// Prints the Claude Code hooks block that records tool-call snapshots in canopyd, and with
// --write merges it into ~/.claude/settings.json after asking. Idempotent: existing canopy
// hooks are replaced, everything else in the file is kept.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const command = resolve(dirname(fileURLToPath(import.meta.url)), 'canopy-hook.mjs')
const MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit'
const entry = () => ({ matcher: MATCHER, hooks: [{ type: 'command', command: `node ${command}`, timeout: 15 }] })
const isOurs = (hook) => hook.hooks?.some((h) => typeof h.command === 'string' && h.command.includes('canopy-hook.mjs'))

const settingsPath = join(homedir(), '.claude', 'settings.json')
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
const hooks = settings.hooks ?? {}
for (const event of ['PreToolUse', 'PostToolUse']) hooks[event] = [...(hooks[event] ?? []).filter((hook) => !isOurs(hook)), entry()]
const next = { ...settings, hooks }

if (!process.argv.includes('--write')) {
  console.log(`Add to ${settingsPath} (or rerun with --write):\n`)
  console.log(JSON.stringify({ hooks: { PreToolUse: [entry()], PostToolUse: [entry()] } }, null, 2))
  process.exit(0)
}
const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question(`Write canopy PreToolUse/PostToolUse hooks into ${settingsPath}? [y/N] `)
rl.close()
if (!/^y(es)?$/i.test(answer.trim())) process.exit(1)
writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
console.log('written — restart open Claude Code sessions to pick it up')
