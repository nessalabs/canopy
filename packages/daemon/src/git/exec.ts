import { execa } from 'execa'

import { ApiError } from '../lib/errors'

export class GitError extends ApiError {
  constructor(args: string[], exitCode: number, stderr: string) {
    super(500, 'git_failed', stderr.trim() || `git ${args[0]} exited with ${exitCode}`, { args, exitCode })
  }
}

export interface RunOptions {
  /** Exit codes to treat as success (e.g. `git diff --no-index` exits 1 when files differ). */
  okCodes?: number[]
  /** Extra environment (e.g. GIT_INDEX_FILE for a throwaway index). */
  env?: Record<string, string>
  /** stdin, for commands that read content or pathspecs that way. */
  input?: string | Buffer
  /** Milliseconds before the command is killed. Commands that can block on a passphrase set it. */
  timeout?: number
  /**
   * Decode stdout as latin1 rather than utf8. latin1 is a byte-for-byte round trip, so content
   * that is not valid utf8 — a CP-1252 file, a stray byte — survives being read, edited and
   * written back. Anything that stages a blob must use it; utf8 would replace those bytes with
   * U+FFFD and commit mojibake.
   */
  binary?: boolean
}

/** The only place in the daemon that spawns git. Returns stdout with the final newline kept. */
export type GitRunner = (cwd: string, args: string[], options?: RunOptions) => Promise<string>

/**
 * Without this git reads every `-- <path>` argument as a pathspec, so a real file called
 * `foo[1].tsx` is treated as a glob and silently matches nothing, and a path starting with `:`
 * is read as pathspec magic. Every path this daemon passes is a literal path from git itself.
 */
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' }

export const runGit: GitRunner = async (cwd, args, { okCodes = [0], env, input, timeout, binary } = {}) => {
  const result = await execa('git', args, {
    cwd,
    env: { ...LITERAL_PATHSPECS, ...env },
    input,
    timeout,
    encoding: binary ? 'buffer' : 'utf8',
    reject: false,
    stripFinalNewline: false,
    maxBuffer: 64 * 1024 * 1024
  })
  // A timeout kills the process, so there is no exit code to report and stderr is usually empty.
  if (result.timedOut) throw new GitError(args, -1, `git ${args[0]} timed out after ${timeout}ms`)
  const exitCode = result.exitCode ?? 1
  if (!okCodes.includes(exitCode)) {
    const text = (stream: unknown): string => (stream instanceof Uint8Array ? Buffer.from(stream).toString('utf8') : String(stream ?? ''))
    // Hooks print their diagnostics to stdout, so a failed `git commit` usually has an empty
    // stderr and everything worth showing on the other stream.
    throw new GitError(args, exitCode, text(result.stderr).trim() || text(result.stdout))
  }
  if (binary) return Buffer.from((result.stdout ?? Buffer.alloc(0)) as Uint8Array).toString('latin1')
  return String(result.stdout ?? '')
}
