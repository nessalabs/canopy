/**
 * The only place in the daemon that spawns the GitHub CLI. `gh` brings its own login (keyring or
 * GH_TOKEN), its own Enterprise host list and its own API pagination, so the daemon never holds
 * a GitHub token of its own.
 */
import { existsSync } from 'node:fs'

import { execa } from 'execa'

export interface GhRun {
  /** False when there is no `gh` to run at all. */
  found: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export type GhRunner = (cwd: string, args: string[], options?: { timeout?: number; input?: string }) => Promise<GhRun>

/**
 * A daemon started by the desktop app inherits a launchd PATH without Homebrew on it, so a `gh`
 * that works in every terminal would read as not installed. These are where installers put it.
 */
const FALLBACK_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh']

/**
 * No prompts (a daemon has no terminal to answer them on), no update nags, no colour codes in
 * the text that is shown back to people.
 */
const QUIET_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', CLICOLOR: '0' }

const DEFAULT_TIMEOUT_MS = 30_000

async function spawnGh(bin: string, cwd: string, args: string[], timeout: number, input?: string): Promise<GhRun | null> {
  const result = await execa(bin, args, { cwd, env: QUIET_ENV, input, reject: false, timeout, stripFinalNewline: false, maxBuffer: 32 * 1024 * 1024 })
  if ((result as { code?: string }).code === 'ENOENT') return null
  if (result.timedOut) return { found: true, exitCode: -1, stdout: '', stderr: `gh ${args[0]} timed out after ${timeout}ms` }
  return { found: true, exitCode: result.exitCode ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** Which binary answered last; found once, then reused until it stops being there. */
let resolved: string | undefined

export const runGh: GhRunner = async (cwd, args, { timeout = DEFAULT_TIMEOUT_MS, input } = {}) => {
  if (resolved && (resolved === 'gh' || existsSync(resolved))) {
    const run = await spawnGh(resolved, cwd, args, timeout, input)
    if (run) return run
  }
  resolved = undefined
  for (const bin of ['gh', ...FALLBACK_PATHS.filter((path) => existsSync(path))]) {
    const run = await spawnGh(bin, cwd, args, timeout, input)
    if (run) {
      resolved = bin
      return run
    }
  }
  return { found: false, exitCode: -1, stdout: '', stderr: '' }
}
