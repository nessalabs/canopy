/**
 * The worktree backend switch: worktrunk (`wt`) when it is installed and the project wants
 * it, plain `git worktree` otherwise.
 *
 * Why prefer `wt`: it owns the path template and, more importantly, it runs the project's
 * hooks. A developer who types `wt switch --create x` in a terminal and one who clicks
 * "New worktree" in Canopy must get the same result, so Canopy drives the same tool instead
 * of racing it. Canopy passes its own path per call (`--config-set worktree-path`) because
 * the template is a Canopy setting, not a user-level worktrunk one.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { BranchSpec } from '@canopy/shared'

import type { GitRunner } from '../../git/exec'
import { conflict } from '../../lib/errors'

/** `wt --version` is a process spawn; the host panel polls, so cache it briefly. */
const INFO_TTL_MS = 10_000

export interface WorktrunkCreateInput {
  /** Primary checkout — `wt` and `git worktree` both run from the repo, not the new path. */
  repoPath: string
  /** Absolute path Canopy wants the worktree at. */
  path: string
  branch: BranchSpec
  /** Project setting; false forces the git fallback even when `wt` is installed. */
  useWt: boolean
  env?: Record<string, string>
  onLine?: (stream: 'out' | 'err', text: string) => void
}

export interface WorktrunkRemoveInput {
  repoPath: string
  path: string
  /** Null for a detached worktree — `wt` addresses worktrees by branch, so that forces git. */
  branch: string | null
  force: boolean
  deleteBranch: 'never' | 'if-merged' | 'always'
  useWt: boolean
  onLine?: (stream: 'out' | 'err', text: string) => void
}

export interface Worktrunk {
  info(): Promise<{ available: boolean; version: string | null; path: string | null }>
  create(input: WorktrunkCreateInput): Promise<{ path: string; backend: 'wt' | 'git'; createdBranch: boolean }>
  remove(input: WorktrunkRemoveInput): Promise<{ backend: 'wt' | 'git'; branchDeleted: boolean }>
}

/** `wt switch --format json` prints exactly this. */
interface SwitchResult {
  action?: string
  branch?: string
  path?: string
  created_branch?: boolean
  base_branch?: string
}

interface RemoveResult {
  branch?: string
  branch_deleted?: boolean
  path?: string
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

/** TOML basic-string escaping for the path Canopy hands to `--config-set`. */
const tomlString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The first JSON object/array in a stdout that may also carry stray human output. */
function parseJsonOutput<T>(stdout: string): T | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const start = trimmed.search(/[[{]/)
    if (start < 0) return null
    try {
      return JSON.parse(trimmed.slice(start)) as T
    } catch {
      return null
    }
  }
}

interface WtRun {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Runs `wt` with stdout buffered (it is the JSON result) and stderr forwarded line by line —
 * worktrunk's progress and hook output goes to stderr, and it is what the user wants to see
 * in the provision log, so it is reported as ordinary output rather than as an error.
 */
function runWt(bin: string, args: string[], cwd: string, env: Record<string, string> | undefined, onLine?: (stream: 'out' | 'err', text: string) => void): Promise<WtRun> {
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

/**
 * @param git the daemon's single git runner (injected so tests observe the same calls the
 *   rest of the daemon makes).
 */
export function createWorktrunk(git: GitRunner, opts: { bin?: string } = {}): Worktrunk {
  const bin = opts.bin ?? 'wt'
  let cached: { at: number; value: { available: boolean; version: string | null; path: string | null } } | null = null

  const info = async (): Promise<{ available: boolean; version: string | null; path: string | null }> => {
    if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.value
    const path = whichSync(bin)
    let value: { available: boolean; version: string | null; path: string | null } = { available: false, version: null, path }
    if (path) {
      try {
        const result = await runWt(bin, ['--version'], process.cwd(), undefined)
        // "wt 0.67.0" — keep just the number so the UI can compare versions.
        const version = /(\d+\.\d+\.\d+\S*)/.exec(`${result.stdout} ${result.stderr}`)?.[1] ?? null
        if (result.exitCode === 0) value = { available: true, version, path }
      } catch {
        value = { available: false, version: null, path: null }
      }
    }
    cached = { at: Date.now(), value }
    return value
  }

  /** `git worktree prune` after any removal: git keeps stale admin files otherwise. */
  const prune = async (repoPath: string): Promise<void> => {
    await git(repoPath, ['worktree', 'prune']).catch(() => '')
  }

  const gitCreate = async (input: WorktrunkCreateInput): Promise<{ path: string; backend: 'wt' | 'git'; createdBranch: boolean }> => {
    const args =
      input.branch.mode === 'new'
        ? ['worktree', 'add', '-b', input.branch.name, input.path, input.branch.base]
        : ['worktree', 'add', input.path, input.branch.name]
    input.onLine?.('out', `git ${args.join(' ')}`)
    await git(input.repoPath, args)
    return { path: input.path, backend: 'git', createdBranch: input.branch.mode === 'new' }
  }

  const gitRemove = async (input: WorktrunkRemoveInput): Promise<{ backend: 'wt' | 'git'; branchDeleted: boolean }> => {
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
      const usable = input.useWt && (await info()).available
      if (!usable) return gitCreate(input)

      const branchName = input.branch.name
      const args = ['switch']
      if (input.branch.mode === 'new') args.push('--create')
      args.push(branchName)
      if (input.branch.mode === 'new') args.push('--base', input.branch.base)
      args.push('--no-cd', '-y', '--format', 'json', '--config-set', `worktree-path = ${tomlString(input.path)}`)

      const result = await runWt(bin, args, input.repoPath, input.env, input.onLine)
      if (result.exitCode !== 0) throw conflict('worktree_create_failed', result.stderr.trim() || `wt switch exited with ${result.exitCode}`)
      const parsed = parseJsonOutput<SwitchResult>(result.stdout)
      if (!parsed?.path) throw conflict('worktree_create_failed', `wt switch printed no path: ${result.stdout.trim().slice(0, 200)}`)
      return { path: parsed.path, backend: 'wt', createdBranch: parsed.created_branch === true }
    },

    async remove(input) {
      // wt addresses worktrees by branch; a detached worktree has none, so git handles it.
      const usable = input.useWt && input.branch !== null && (await info()).available
      if (!usable) return gitRemove(input)

      const args = ['remove', input.branch as string, '--foreground', '-y', '--format', 'json']
      if (input.force) args.push('--force')
      if (input.deleteBranch === 'never') args.push('--no-delete-branch')
      if (input.deleteBranch === 'always') args.push('-D')

      const result = await runWt(bin, args, input.repoPath, undefined, input.onLine)
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || `wt remove exited with ${result.exitCode}`
        if (/uncommitted changes|dirty/i.test(message)) throw conflict('worktree_dirty', message)
        throw conflict('worktree_remove_failed', message)
      }
      const parsed = parseJsonOutput<RemoveResult[] | RemoveResult>(result.stdout)
      const first = Array.isArray(parsed) ? parsed[0] : parsed
      await prune(input.repoPath)
      return { backend: 'wt', branchDeleted: first?.branch_deleted === true }
    }
  }
}
