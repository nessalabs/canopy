#!/usr/bin/env node
// Claude Code hook command: forwards the PreToolUse/PostToolUse payload on stdin to canopyd so it
// can snapshot the worktree around the tool call. Always exits 0 — a missing daemon must never
// block the agent. Configure with `npm run hooks:setup`.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.CANOPY_HOME ?? join(homedir(), '.canopy')
const port = process.env.CANOPY_PORT ?? '9483'
try {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  const body = readFileSync(0, 'utf8')
  await fetch(`http://127.0.0.1:${port}/api/v1/hooks/claude`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000)
  })
} catch {
  // daemon down, token missing, or malformed payload: nothing to record
}
