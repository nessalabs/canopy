/**
 * Running `canopyd`: one spawn, one envelope parse, one retry policy, for every caller.
 *
 * `backend.ts` (the worktree itself) and `canopyd.ts` (what happens after it exists) used to
 * carry a copy of this each. They also have to run the tool with the same environment — the
 * shared port registry and the daemon's port range — or `canopyd rm` would release ports from a
 * different table than `canopyd ports` allocated them in.
 */
import { spawn } from 'node:child_process'

/** The envelope every `canopyd --json` command prints, success or failure. */
export interface Envelope<T> {
  v: number
  ok: boolean
  command: string
  data?: T
  error?: { code: string; message: string; details?: unknown }
  warnings: string[]
}

export interface ToolRun {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type OnLine = (stream: 'out' | 'err', text: string) => void

/**
 * How often, and how long apart, a command that found the registry locked is tried again.
 * `locked` is the one failure the tool documents as retryable unchanged: another `canopyd` —
 * usually this daemon provisioning a second worktree — held the port registry's lock.
 */
const LOCKED_RETRIES = 3
const LOCKED_BACKOFF_MS = 400

/**
 * Runs the tool with stdout buffered (it is the envelope) and stderr forwarded line by line —
 * progress goes to stderr by design, and it is what belongs in the provision log, so it is
 * reported as ordinary output rather than as an error.
 */
function spawnTool(bin: string, args: string[], cwd: string, env: Record<string, string>, onLine?: OnLine): Promise<ToolRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
export function parseEnvelope<T>(stdout: string): Envelope<T> | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed = JSON.parse(trimmed) as Envelope<T>
    return parsed.v === 1 ? parsed : null
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `canopyd`, trying again while the envelope says `locked`. The environment is the
 * caller's own on top of the daemon's (`process.env`); `CANOPY_DAEMON=1` tells the tool who is
 * calling.
 */
export async function runTool(bin: string, args: string[], opts: { cwd: string; env?: Record<string, string>; onLine?: OnLine }): Promise<ToolRun> {
  const env = { ...(opts.env ?? {}), CANOPY_DAEMON: '1' }
  for (let attempt = 0; ; attempt += 1) {
    const result = await spawnTool(bin, args, opts.cwd, env, opts.onLine)
    const locked = parseEnvelope(result.stdout)?.error?.code === 'locked'
    if (!locked || attempt >= LOCKED_RETRIES) return result
    await sleep(LOCKED_BACKOFF_MS * (attempt + 1))
  }
}
