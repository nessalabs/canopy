/**
 * The worktree backend: `canopywt` when it is installed, plain `git worktree` otherwise.
 *
 * This used to drive worktrunk (`wt`). It drives our own tool now, for two reasons. Worktrunk
 * owned a second config file — `.config/wt.toml` — so a project's settings lived in two places
 * and Canopy had to rewrite a slice of a file it did not own. And Canopy used three of its
 * commands out of a tool with an interactive picker, CI status and LLM branch summaries.
 *
 * `canopywt` reads the same `canopy.yaml` Canopy does, prints one JSON envelope per command, and
 * does the parts plain git does not: a dirty check that says what is at stake, `worktree prune`
 * after a removal, and a branch-deletion policy.
 *
 * The git fallback stays until `canopywt` ships as a prebuilt binary — a Canopy user should not
 * need a Rust toolchain. It creates and removes worktrees and nothing else.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { BranchSpec } from '@canopy/shared'

import type { GitRunner } from '../../git/exec'
import { conflict } from '../../lib/errors'

/** `canopywt --version` is a process spawn; the host panel polls, so cache it briefly. */
const INFO_TTL_MS = 10_000

/** Which tool actually did the work, for the provision log and the host panel. */
export type Backend = 'canopywt' | 'git'

export interface WorktreeCreateInput {
  /** Primary checkout — both backends run from the repo, not the new path. */
  repoPath: string
  /** Absolute path Canopy wants the worktree at. */
  path: string
  branch: BranchSpec
  /** Project setting; false forces the git fallback even when `canopywt` is installed. */
  useTool: boolean
  env?: Record<string, string>
  onLine?: (stream: 'out' | 'err', text: string) => void
}

export interface WorktreeRemoveInput {
  repoPath: string
  path: string
  /** Null for a detached worktree; `canopywt` addresses those by path. */
  branch: string | null
  force: boolean
  deleteBranch: 'never' | 'if-merged' | 'always'
  useTool: boolean
  onLine?: (stream: 'out' | 'err', text: string) => void
}

export interface ToolInfo {
  available: boolean
  version: string | null
  path: string | null
}

export interface WorktreeBackend {
  info(): Promise<ToolInfo>
  create(input: WorktreeCreateInput): Promise<{ path: string; backend: Backend; createdBranch: boolean }>
  remove(input: WorktreeRemoveInput): Promise<{ backend: Backend; branchDeleted: boolean }>
}

/** The envelope every `canopywt --json` command prints, success or failure. */
interface Envelope<T> {
  v: number
  ok: boolean
  command: string
  data?: T
  error?: { code: string; message: string; details?: unknown }
  warnings: string[]
}

interface CreateData {
  path: string
  branch: string
  created_branch: boolean
  base: string | null
}

interface RemoveData {
  path: string
  branch: string | null
  branch_deleted: boolean
}

/** Absolute path of a binary on PATH, for HostInfo. */
function whichSync(bin: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

interface Run {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Runs the tool with stdout buffered (it is the JSON envelope) and stderr forwarded line by
 * line — progress goes to stderr by design, and it is what the user wants to see in the
 * provision log, so it is reported as ordinary output rather than as an error.
 */
function run(bin: string, args: string[], cwd: string, env: Record<string, string> | undefined, onLine?: (stream: 'out' | 'err', text: string) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}), CANOPY_DAEMON: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
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

/**
 * `canopywt` error codes are a stable API, so they map to Canopy's conflicts by code rather
 * than by matching message text.
 */
function toConflict(code: string, message: string): Error {
  switch (code) {
    case 'worktree_dirty':
      return conflict('worktree_dirty', message)
    case 'worktree_exists':
      return conflict('worktree_exists', message)
    case 'worktree_not_found':
      return conflict('worktree_not_found', message)
    case 'worktree_create_failed':
    case 'branch_not_found':
      return conflict('worktree_create_failed', message)
    default:
      return conflict('worktree_remove_failed', message)
  }
}

/**
 * @param git the daemon's single git runner (injected so tests observe the same calls the
 *   rest of the daemon makes).
 */
export function createWorktreeBackend(git: GitRunner, opts: { bin?: string } = {}): WorktreeBackend {
  const bin = opts.bin ?? 'canopywt'
  let cached: { at: number; value: ToolInfo } | null = null

  const info = async (): Promise<ToolInfo> => {
    if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.value
    const path = whichSync(bin)
    let value: ToolInfo = { available: false, version: null, path }
    if (path) {
      try {
        const result = await run(bin, ['--version'], process.cwd(), undefined)
        // "canopywt 0.1.0" — keep just the number so the UI can compare versions.
        const version = /(\d+\.\d+\.\d+\S*)/.exec(`${result.stdout} ${result.stderr}`)?.[1] ?? null
        if (result.exitCode === 0) value = { available: true, version, path }
      } catch {
        value = { available: false, version: null, path: null }
      }
    }
    cached = { at: Date.now(), value }
    return value
  }

  /** `git worktree prune` after any fallback removal: git keeps stale admin files otherwise. */
  const prune = async (repoPath: string): Promise<void> => {
    await git(repoPath, ['worktree', 'prune']).catch(() => '')
  }

  const gitCreate = async (input: WorktreeCreateInput): Promise<{ path: string; backend: Backend; createdBranch: boolean }> => {
    const args =
      input.branch.mode === 'new'
        ? ['worktree', 'add', '-b', input.branch.name, input.path, input.branch.base]
        : ['worktree', 'add', input.path, input.branch.name]
    input.onLine?.('out', `git ${args.join(' ')}`)
    await git(input.repoPath, args)
    return { path: input.path, backend: 'git', createdBranch: input.branch.mode === 'new' }
  }

  const gitRemove = async (input: WorktreeRemoveInput): Promise<{ backend: Backend; branchDeleted: boolean }> => {
    if (existsSync(input.path)) {
      const args = input.force ? ['worktree', 'remove', '--force', input.path] : ['worktree', 'remove', input.path]
      input.onLine?.('out', `git ${args.join(' ')}`)
      try {
        await git(input.repoPath, args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/contains modified or untracked files|is dirty/i.test(message)) throw conflict('worktree_dirty', message)
        throw error
      }
    }
    await prune(input.repoPath)
    let branchDeleted = false
    if (input.branch && input.deleteBranch !== 'never') {
      // `-d` fails when the branch is not merged; that is the answer, not an error.
      const flag = input.deleteBranch === 'always' ? '-D' : '-d'
      branchDeleted = await git(input.repoPath, ['branch', flag, input.branch]).then(
        () => true,
        () => false
      )
    }
    return { backend: 'git', branchDeleted }
  }

  return {
    info,

    async create(input) {
      const usable = input.useTool && (await info()).available
      if (!usable) return gitCreate(input)

      // Canopy renders the path itself, so the tool is told where to put the worktree rather
      // than consulting the `worktree.path` template.
      const args = ['new', input.branch.name, '--path', input.path, '--json']
      if (input.branch.mode === 'existing') args.push('--existing')
      else if (input.branch.base) args.push('--base', input.branch.base)

      const result = await run(bin, args, input.repoPath, input.env, input.onLine)
      const envelope = parseEnvelope<CreateData>(result.stdout)
      if (!envelope) {
        throw conflict('worktree_create_failed', result.stderr.trim() || `canopywt new exited with ${result.exitCode}`)
      }
      if (!envelope.ok || !envelope.data) {
        throw toConflict(envelope.error?.code ?? 'worktree_create_failed', envelope.error?.message ?? 'canopywt new failed')
      }
      return { path: envelope.data.path, backend: 'canopywt', createdBranch: envelope.data.created_branch }
    },

    async remove(input) {
      const usable = input.useTool && (await info()).available
      if (!usable) return gitRemove(input)

      // A detached worktree has no branch, so it is addressed by path. `canopywt rm` accepts
      // either.
      const target = input.branch ?? input.path
      const args = ['rm', target, '--delete-branch', input.deleteBranch, '--json']
      if (input.force) args.push('--force')

      const result = await run(bin, args, input.repoPath, undefined, input.onLine)
      const envelope = parseEnvelope<RemoveData>(result.stdout)
      if (!envelope) {
        throw conflict('worktree_remove_failed', result.stderr.trim() || `canopywt rm exited with ${result.exitCode}`)
      }
      if (!envelope.ok || !envelope.data) {
        throw toConflict(envelope.error?.code ?? 'worktree_remove_failed', envelope.error?.message ?? 'canopywt rm failed')
      }
      return { backend: 'canopywt', branchDeleted: envelope.data.branch_deleted }
    }
  }
}
