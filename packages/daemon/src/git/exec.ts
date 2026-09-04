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
}

/** The only place in the daemon that spawns git. Returns stdout with the final newline kept. */
export type GitRunner = (cwd: string, args: string[], options?: RunOptions) => Promise<string>

export const runGit: GitRunner = async (cwd, args, { okCodes = [0], env } = {}) => {
  const result = await execa('git', args, { cwd, env, reject: false, stripFinalNewline: false, maxBuffer: 64 * 1024 * 1024 })
  const exitCode = result.exitCode ?? 1
  if (!okCodes.includes(exitCode)) throw new GitError(args, exitCode, String(result.stderr ?? ''))
  return String(result.stdout ?? '')
}
