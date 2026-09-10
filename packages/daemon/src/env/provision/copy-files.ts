/**
 * `git worktree add` brings tracked files only. Copy rules carry the untracked/ignored ones a
 * dev environment needs (.env, local certs, editor config) from a source checkout into the new
 * worktree, by copy or symlink. Candidates are what git ignores in the source checkout.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import picomatch from 'picomatch'

import type { CopyFileRule } from '@canopy/shared'

import type { GitRunner } from '../../git/exec'
import { splitNul } from '../../git/parse'
import type { LogSink } from '../types'

const IGNORED_DIRS_NEVER_OFFERED = ['node_modules/', '.venv/', 'target/', 'dist/', 'build/', '.next/', '.turbo/', '__pycache__/', '.cache/', '.git/', 'coverage/', '.DS_Store']

/** Untracked (incl. ignored) files in a checkout, repo-relative; directories are expanded one level for candidates. */
export async function untrackedFiles(git: GitRunner, root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '--others', '-z'])
  return splitNul(out)
}

/**
 * Ignored files a user probably wants in every worktree: small, top-level-ish, not build output.
 * Used by the settings UI ("detected in the main checkout but not listed").
 */
export async function copyCandidates(git: GitRunner, root: string, rules: CopyFileRule[]): Promise<string[]> {
  const files = await untrackedFiles(git, root)
  const covered = rules.map((rule) => picomatch(rule.pattern, { dot: true }))
  return files
    .filter((file) => !IGNORED_DIRS_NEVER_OFFERED.some((prefix) => file.startsWith(prefix) || file.includes(`/${prefix}`)))
    .filter((file) => file.split('/').length <= 3)
    .filter((file) => /(^|\/)\.env|\.local\.|local\.json$|\.pem$|\.key$|\.p12$|\.secret|\.envrc$|\.tool-versions$|\.nvmrc$|\.python-version$/.test(file))
    .filter((file) => !covered.some((match) => match(file)))
    .filter((file) => {
      try {
        return statSync(join(root, file)).size < 5 * 1024 * 1024
      } catch {
        return false
      }
    })
    .sort()
    .slice(0, 50)
}

export interface CopyFilesInput {
  git: GitRunner
  sourceRoot: string
  targetRoot: string
  rules: CopyFileRule[]
  logs: LogSink
}

/** Applies the rules; returns the repo-relative paths that landed in the worktree. */
export async function copyFiles(input: CopyFilesInput): Promise<string[]> {
  if (input.rules.length === 0) return []
  const files = await untrackedFiles(input.git, input.sourceRoot)
  const copied: string[] = []
  for (const rule of input.rules) {
    if (rule.pattern.trim() === '') continue
    const isMatch = picomatch(rule.pattern.replace(/\/$/, ''), { dot: true })
    // A rule naming a directory matches everything beneath it.
    const matches = files.filter((file) => isMatch(file) || file.startsWith(`${rule.pattern.replace(/\/$/, '')}/`))
    for (const file of matches) {
      const source = join(input.sourceRoot, file)
      const target = join(input.targetRoot, file)
      if (!existsSync(source) || existsSync(target) || isSymlink(target)) continue
      try {
        mkdirSync(dirname(target), { recursive: true })
        if (rule.strategy === 'symlink') symlinkSync(source, target)
        else copyFileSync(source, target)
        copied.push(file)
      } catch (error) {
        input.logs.err(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (matches.length === 0 && !rule.pattern.includes('*')) {
      // A literal path that exists but is tracked by git needs no copy; only log the truly missing.
      if (!existsSync(join(input.sourceRoot, rule.pattern))) input.logs.sys(`${rule.pattern}: not present in ${input.sourceRoot}`)
    }
  }
  if (copied.length > 0) input.logs.sys(`copied ${copied.length} file(s): ${copied.join(', ')}`)
  return copied
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Directories one level under root, for scaffolding heuristics. */
export const listDirs = (root: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
