/**
 * Driving `canopyd` for the provisioning steps Canopy used to implement itself.
 *
 * Copying gitignored files, linking caches and allocating ports were three TypeScript modules
 * (437 lines) doing what the crate now does behind one flag each. They are gone; this is what
 * replaced them. `backend.ts` covers the worktree itself — this covers what happens after it
 * exists.
 *
 * Everything here is a `--json` call, so failures arrive as a stable `error.code` rather than
 * as text to match against, and every result is one object rather than a stream to parse.
 *
 * Every call runs with `cwd` set to the **worktree**, not the main checkout. The crate resolves
 * `canopy.yaml` the way Canopy does — the worktree's own copy wins — and it resolves it relative
 * to where it was invoked, so running from the main checkout would silently use the wrong file
 * for a branch that changed what it runs.
 */
import { spawn } from 'node:child_process'

import type { CacheRule, CacheStrategy, CopyFileRule, PortSpec } from '@canopy/shared'

import { conflict } from '../../lib/errors'

/** The envelope every `canopyd --json` command prints, success or failure. */
interface Envelope<T> {
  v: number
  ok: boolean
  command: string
  data?: T
  error?: { code: string; message: string; details?: unknown }
  warnings: string[]
}

export interface CopiedEntry {
  path: string
  strategy: 'copy' | 'clone' | 'symlink'
  result: 'cloned' | 'copied' | 'symlinked' | 'skipped' | 'planned'
  bytes: number
  millis: number
}

export interface CopyResult {
  entries: CopiedEntry[]
  failures: Array<{ path: string; strategy: string; message: string }>
}

export interface Canopyd {
  available(): Promise<boolean>
  /** Carries gitignored files from `source` into the worktree, with explicit rules. */
  copy(input: { cwd: string; branch: string; source: string; rules: Array<{ pattern: string; strategy: string }>; onLine?: OnLine }): Promise<CopyResult>
  /** Allocate-if-absent for every declared port; idempotent, and the numbers never move. */
  ports(input: { cwd: string; branch: string; onLine?: OnLine }): Promise<Record<string, number>>
  /** Hands a branch's ports back to the pool. */
  releasePorts(input: { cwd: string; branch: string }): Promise<number>
  /** Runs the worktree's `setup:` steps, with Canopy's resolved environment layered on top. */
  setup(input: { cwd: string; branch: string; env: Record<string, string>; force?: boolean; onLine?: OnLine }): Promise<SetupResult>
}

export interface SetupStepOutcome {
  name: string
  command: string
  result: { kind: 'ran'; millis: number } | { kind: 'skipped'; reason: string } | { kind: 'failed'; status: string; tail: string[]; millis: number }
}

export interface SetupResult {
  steps: SetupStepOutcome[]
  ok: boolean
}

type OnLine = (stream: 'out' | 'err', text: string) => void

/**
 * Runs the tool with stdout buffered (it is the envelope) and stderr streamed — progress goes
 * to stderr by design, and it is what belongs in the provision log.
 */
function run(bin: string, args: string[], cwd: string, onLine?: OnLine): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, CANOPY_DAEMON: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let pending = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const part of parts) onLine?.('out', part.replace(/\r$/, ''))
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (pending.length > 0) onLine?.('out', pending)
      resolve({ exitCode: code, stdout, stderr })
    })
  })
}

/** The envelope, or null when stdout was not one. */
function parseEnvelope<T>(stdout: string): Envelope<T> | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed = JSON.parse(trimmed) as Envelope<T>
    return parsed.v === 1 ? parsed : null
  } catch {
    return null
  }
}

/** Unwraps a successful envelope, or throws with the code the tool chose. */
function unwrap<T>(command: string, result: { exitCode: number | null; stdout: string; stderr: string }): T {
  const envelope = parseEnvelope<T>(result.stdout)
  if (!envelope) {
    throw conflict('provision_failed', result.stderr.trim() || `canopyd ${command} exited with ${result.exitCode}`)
  }
  if (!envelope.ok || envelope.data === undefined) {
    // `error.code` is a stable API, so it is carried through rather than flattened.
    throw conflict(envelope.error?.code ?? 'provision_failed', envelope.error?.message ?? `canopyd ${command} failed`)
  }
  return envelope.data
}

/** A Canopy cache strategy as the crate spells it. `fresh` means "do not copy at all". */
const copyStrategyFor = (strategy: CacheStrategy | CopyFileRule['strategy']): string | null => {
  switch (strategy) {
    case 'fresh':
      return null
    case 'clone':
      return 'clone'
    case 'symlink':
      return 'symlink'
    default:
      return 'copy'
  }
}

/**
 * Canopy's copy rules and cache rules are one thing to the crate: both name gitignored paths to
 * carry into a worktree, and `node_modules` is as gitignored as `.env` is. Folding them here is
 * what let `caches.ts` go.
 */
export function rulesFor(copyFiles: CopyFileRule[], caches: CacheRule[]): Array<{ pattern: string; strategy: string }> {
  const rules: Array<{ pattern: string; strategy: string }> = []
  for (const rule of copyFiles) {
    const strategy = copyStrategyFor(rule.strategy)
    if (strategy) rules.push({ pattern: rule.pattern, strategy })
  }
  for (const rule of caches) {
    const strategy = copyStrategyFor(rule.strategy)
    if (strategy) rules.push({ pattern: rule.path, strategy })
  }
  return rules
}

export function createCanopyd(opts: { bin?: string } = {}): Canopyd {
  const bin = opts.bin ?? 'canopyd'

  return {
    async available() {
      try {
        const result = await run(bin, ['--version'], process.cwd())
        return result.exitCode === 0
      } catch {
        return false
      }
    },

    async copy({ cwd, branch, source, rules, onLine }) {
      if (rules.length === 0) return { entries: [], failures: [] }
      const args = ['copy', branch, '--from', source, '--json']
      for (const rule of rules) args.push('--rule', `${rule.pattern}=${rule.strategy}`)
      return unwrap<CopyResult>('copy', await run(bin, args, cwd, onLine))
    },

    async ports({ cwd, branch, onLine }) {
      return unwrap<Record<string, number>>('ports', await run(bin, ['ports', branch, '--json'], cwd, onLine))
    },

    async releasePorts({ cwd, branch }) {
      const data = unwrap<{ released: number }>('ports', await run(bin, ['ports', branch, '--release', '--json'], cwd))
      return data.released
    },

    async setup({ cwd, branch, env, force, onLine }) {
      const args = ['setup', branch, '--json']
      if (force) args.push('--force')
      // Canopy's environment is richer than the crate can resolve on its own — database URLs
      // come from forks it knows nothing about — so it is passed through rather than re-derived.
      for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)

      const result = await run(bin, args, cwd, onLine)
      const envelope = parseEnvelope<SetupResult>(result.stdout)
      if (!envelope) {
        throw conflict('setup_failed', result.stderr.trim() || `canopyd setup exited with ${result.exitCode}`)
      }
      // A failing step is a verdict, not a fault: the data is still there, and the caller wants
      // to show which step failed and why rather than just that something did.
      if (envelope.data) return envelope.data
      throw conflict(envelope.error?.code ?? 'setup_failed', envelope.error?.message ?? 'canopyd setup failed')
    }
  }
}

/** Declared ports, for the "nothing to do" check the step makes before spawning anything. */
export const hasPorts = (ports: Record<string, PortSpec> | undefined): boolean => Object.keys(ports ?? {}).length > 0
