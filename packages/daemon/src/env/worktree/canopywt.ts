/**
 * Driving `canopywt` for the provisioning steps Canopy used to implement itself.
 *
 * Copying gitignored files, linking caches and allocating ports were three TypeScript modules
 * (437 lines) doing what the crate now does behind one flag each. They are gone; this is what
 * replaced them. `backend.ts` covers the worktree itself — this covers what happens after it
 * exists.
 *
 * Everything here is a `--json` call, so failures arrive as a stable `error.code` rather than
 * as text to match against, and every result is one object rather than a stream to parse.
 */
import { spawn } from 'node:child_process'

import type { CacheRule, CacheStrategy, CopyFileRule, PortSpec } from '@canopy/shared'

import { conflict } from '../../lib/errors'

/** The envelope every `canopywt --json` command prints, success or failure. */
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

export interface Canopywt {
  available(): Promise<boolean>
  /** Carries gitignored files from `source` into the worktree, with explicit rules. */
  copy(input: { repoPath: string; branch: string; source: string; rules: Array<{ pattern: string; strategy: string }>; onLine?: OnLine }): Promise<CopyResult>
  /** Allocate-if-absent for every declared port; idempotent, and the numbers never move. */
  ports(input: { repoPath: string; branch: string; onLine?: OnLine }): Promise<Record<string, number>>
  /** Hands a branch's ports back to the pool. */
  releasePorts(input: { repoPath: string; branch: string }): Promise<number>
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
    throw conflict('provision_failed', result.stderr.trim() || `canopywt ${command} exited with ${result.exitCode}`)
  }
  if (!envelope.ok || envelope.data === undefined) {
    // `error.code` is a stable API, so it is carried through rather than flattened.
    throw conflict(envelope.error?.code ?? 'provision_failed', envelope.error?.message ?? `canopywt ${command} failed`)
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

export function createCanopywt(opts: { bin?: string } = {}): Canopywt {
  const bin = opts.bin ?? 'canopywt'

  return {
    async available() {
      try {
        const result = await run(bin, ['--version'], process.cwd())
        return result.exitCode === 0
      } catch {
        return false
      }
    },

    async copy({ repoPath, branch, source, rules, onLine }) {
      if (rules.length === 0) return { entries: [], failures: [] }
      const args = ['copy', branch, '--from', source, '--json']
      for (const rule of rules) args.push('--rule', `${rule.pattern}=${rule.strategy}`)
      return unwrap<CopyResult>('copy', await run(bin, args, repoPath, onLine))
    },

    async ports({ repoPath, branch, onLine }) {
      return unwrap<Record<string, number>>('ports', await run(bin, ['ports', branch, '--json'], repoPath, onLine))
    },

    async releasePorts({ repoPath, branch }) {
      const data = unwrap<{ released: number }>('ports', await run(bin, ['ports', branch, '--release', '--json'], repoPath))
      return data.released
    }
  }
}

/** Declared ports, for the "nothing to do" check the step makes before spawning anything. */
export const hasPorts = (ports: Record<string, PortSpec> | undefined): boolean => Object.keys(ports ?? {}).length > 0
