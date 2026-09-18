/**
 * Suggesting copy rules to the user.
 *
 * The copying itself is `canopyd copy` now; this is only the scan behind "detected in the main
 * checkout but not listed" in project settings, which needs Canopy's own idea of what a
 * developer probably wants carried across.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

import picomatch from 'picomatch'

import type { CopyFileRule } from '@canopy/shared'

import type { GitRunner } from '../../git/exec'
import { splitNul } from '../../git/parse'

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
