/**
 * Staging and committing. The organising idea is that the commit panel's checkbox *is* git's
 * index: checking a file runs `git add`, unchecking runs `git reset`, and committing is a plain
 * `git commit` of an index the user has been looking at. Nothing is kept beside the index and
 * reconciled with it later, so staging done in a terminal is never quietly discarded and a file
 * the user unchecked cannot end up in the commit.
 *
 * The one place that needs care is hunk-level staging, because rebuilding a file's index entry
 * from HEAD plus a chosen set of hunks can only be safe if everything currently staged for that
 * file is expressible as those same hunks. `hunkStates` proves that before `stageHunks` will
 * touch anything — see `representable` below.
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  applyHunks,
  hashPatch,
  splitPatch,
  type ChangesResponse,
  type Commit,
  type CommitInput,
  type ExcludeInput,
  type HiddenPath,
  type HunkStatesResponse,
  type PatchHunk,
  type StageHunksInput,
  type StageInput,
  type UnhideInput
} from '@canopy/shared'

import type { EventBus } from '../env/types'
import type { DiffReader } from '../git/diff'
import type { GitRunner } from '../git/exec'
import type { StatusEntry } from '../git/parse'
import type { Repo } from '../git/repo'
import { badRequest, conflict } from '../lib/errors'
import { EMPTY_TREE, repoPath, type HistoryService } from '../worktrees/history'
import type { WorktreesService } from '../worktrees/service'
import { editPatternFile, managedPatterns, readIfPresent, toPattern, withPatterns, withoutPatterns } from './exclude'
import { gitPathOf, operationIn } from './status'

/** Signing without a cached passphrase blocks on a pinentry prompt that will never come. */
const COMMIT_TIMEOUT_MS = 120_000

/** Blob modes we can rewrite. A symlink or a gitlink is not text and has no hunks to pick. */
const STAGEABLE_MODES = new Set(['100644', '100755'])

/**
 * Diff flags for anything whose output will be applied back into the index. `--no-textconv` is
 * the one that matters: with a `diff=<driver>` attribute (LFS, docx) git would otherwise hand
 * back converted, human-readable text, and staging that would write garbage into the repo.
 */
const STAGING_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', '--src-prefix=a/', '--dst-prefix=b/']

interface Deps {
  repo: Repo
  diffs: DiffReader
  git: GitRunner
  worktrees: WorktreesService
  history: HistoryService
  events: EventBus
}

/** Identity of one atomic change, for asking whether the same change is staged. */
const atomKey = (hunk: PatchHunk): string => `${hunk.oldStart},${hunk.oldLines}:${hunk.lines.join('\n')}`

export class CommitService {
  /**
   * git does not retry `.git/index.lock`; `add`, `reset`, `update-index` and `commit` all fail
   * hard when they cannot take it. Nothing else in the daemon serializes git per worktree, so
   * every index write goes through here.
   */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: Deps) {}

  private locked<T>(cwd: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(cwd) ?? Promise.resolve()
    // `work` runs whether the previous link settled or failed, so one error cannot wedge the
    // worktree; the stored tail swallows results so nothing keeps a rejection unhandled.
    const next = previous.then(work, work)
    this.locks.set(
      cwd,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  /** The checkout, the revision its working tree is compared against, and whether HEAD exists. */
  private async context(worktreeId: string): Promise<{ cwd: string; rev: string; hasHead: boolean }> {
    const { path } = this.deps.worktrees.location(worktreeId)
    const rev = (await this.deps.repo.resolveCommit(path, 'HEAD')) ?? EMPTY_TREE
    return { cwd: path, rev, hasHead: rev !== EMPTY_TREE }
  }

  private changes(worktreeId: string): Promise<ChangesResponse> {
    return this.deps.history.changes(worktreeId, { kind: 'worktree', against: 'head' })
  }

  /** Staging individual paths during a merge or rebase can discard a conflict resolution. */
  private async refuseDuringOperation(cwd: string): Promise<void> {
    const operation = await operationIn(this.deps.repo, cwd)
    if (operation) throw conflict('operation_in_progress', `a ${operation} is in progress; finish or abort it before staging individual paths`)
  }

  async stage(worktreeId: string, input: StageInput): Promise<ChangesResponse> {
    const { cwd, hasHead } = await this.context(worktreeId)
    const stage = input.stage.map(repoPath).filter(Boolean)
    const unstage = input.unstage.map(repoPath).filter(Boolean)
    if (stage.length === 0 && unstage.length === 0) return this.changes(worktreeId)
    await this.locked(cwd, async () => {
      await this.refuseDuringOperation(cwd)
      // Unstage first: a path in both lists is being re-staged from the working tree.
      await this.deps.repo.unstagePaths(cwd, unstage, hasHead)
      await this.deps.repo.stagePaths(cwd, stage)
    })
    return this.changes(worktreeId)
  }

  /** The two `-U0` diffs a file's hunk states are derived from, plus what the UI is showing. */
  private async hunkContext(cwd: string, rev: string, path: string, entry: StatusEntry | undefined) {
    const untracked = entry === undefined || entry.untracked
    const worktreeArgs = untracked
      ? ['diff', '--no-index', ...STAGING_FLAGS, '--', '/dev/null', path]
      : ['diff', ...STAGING_FLAGS, rev, '--', path]
    const [display, worktree, staged] = await Promise.all([
      this.deps.diffs.patch(cwd, { kind: 'worktree', rev }, path),
      this.deps.git(cwd, worktreeArgs, { okCodes: [0, 1], binary: true }),
      this.deps.git(cwd, ['diff', '--cached', ...STAGING_FLAGS, rev, '--', path], { okCodes: [0, 1], binary: true })
    ])
    return { display, worktreeAtoms: splitPatch(worktree).hunks, stagedAtoms: splitPatch(staged).hunks }
  }

  async hunkStates(worktreeId: string, file: string): Promise<HunkStatesResponse> {
    const path = repoPath(file)
    const { cwd, rev } = await this.context(worktreeId)
    const entry = (await this.deps.repo.statusEntries(cwd)).entries.find((candidate) => candidate.path === path)
    const { display, worktreeAtoms, stagedAtoms } = await this.hunkContext(cwd, rev, path, entry)
    const patch = display.patch ?? ''
    const hunks = splitPatch(patch).hunks

    const inWorktree = new Set(worktreeAtoms.map(atomKey))
    // Every staged change must also be one of the working tree's changes. When it is not, the
    // index holds something these hunks cannot express — the same line staged as one thing and
    // then edited to another, say — and rebuilding the entry from HEAD would silently throw that
    // work away. So we refuse rather than guess.
    const representable = stagedAtoms.every((atom) => inWorktree.has(atomKey(atom)))
    const stagedKeys = new Set(stagedAtoms.map(atomKey))

    const staged: number[] = []
    const partial: number[] = []
    for (const hunk of hunks) {
      const atoms = atomsOf(worktreeAtoms, hunk)
      if (atoms.length === 0) continue
      const count = atoms.filter((atom) => stagedKeys.has(atomKey(atom))).length
      if (count === atoms.length) staged.push(hunk.index)
      else if (count > 0) partial.push(hunk.index)
    }
    return { path, patchHash: hashPatch(patch), staged, partial, representable }
  }

  async stageHunks(worktreeId: string, input: StageHunksInput): Promise<ChangesResponse> {
    const path = repoPath(input.path)
    const { cwd, rev, hasHead } = await this.context(worktreeId)
    await this.locked(cwd, async () => {
      await this.refuseDuringOperation(cwd)
      const entry = (await this.deps.repo.statusEntries(cwd)).entries.find((candidate) => candidate.path === path)
      if (entry?.conflicted) throw conflict('conflicted', `${path} is unmerged; resolve it before staging parts of it`)
      if (entry && entry.sub !== 'N...') throw badRequest('unsupported_path', `${path} is a submodule; stage it whole or not at all`)

      const { display, worktreeAtoms, stagedAtoms } = await this.hunkContext(cwd, rev, path, entry)
      if (display.patch === null) throw badRequest('unsupported_path', `${path} has no text diff to pick hunks from`)
      // The client picked against a patch; if the file moved underneath, those indices now name
      // different lines. Recomputing here and comparing is what makes the operation safe.
      if (hashPatch(display.patch) !== input.patchHash) throw conflict('stale_patch', `${path} changed while you were picking hunks; reopen it and try again`)
      const inWorktree = new Set(worktreeAtoms.map(atomKey))
      if (!stagedAtoms.every((atom) => inWorktree.has(atomKey(atom)))) {
        throw conflict('not_representable', `${path} is staged in a way these hunks cannot express; stage or unstage the whole file first`)
      }

      const hunks = splitPatch(display.patch).hunks
      const wanted = new Set(input.hunks)
      const chosen = new Set<number>()
      for (const hunk of hunks) {
        if (!wanted.has(hunk.index)) continue
        for (const atom of atomsOf(worktreeAtoms, hunk)) chosen.add(atom.index)
      }

      if (chosen.size === 0) {
        await this.deps.repo.unstagePaths(cwd, [path], hasHead)
        return
      }

      const mode = await stageableMode(cwd, path, entry)
      const base = entry?.headSha ? await this.deps.repo.catBlob(cwd, entry.headSha) : ''
      const content = applyHunks(base, worktreeAtoms, chosen)
      const sha = await this.deps.repo.writeBlob(cwd, path, content)
      await this.deps.repo.updateIndexEntry(cwd, mode, sha, path)
    })
    return this.changes(worktreeId)
  }

  async commit(worktreeId: string, input: CommitInput): Promise<Commit> {
    const { cwd } = await this.context(worktreeId)
    return this.locked(cwd, async () => {
      const { entries } = await this.deps.repo.statusEntries(cwd)
      if (entries.some((entry) => entry.conflicted)) throw conflict('conflicted', 'resolve the remaining conflicts before committing')
      if (!entries.some((entry) => !entry.untracked && entry.x !== '.')) throw badRequest('nothing_staged', 'nothing is staged; check at least one file')

      const message = input.description?.trim() ? `${input.summary.trim()}\n\n${input.description.trim()}\n` : `${input.summary.trim()}\n`
      const sha = await this.deps.repo.commitIndex(cwd, message, { noVerify: input.noVerify, timeout: COMMIT_TIMEOUT_MS })
      const commit = await this.deps.repo.commit(cwd, sha)
      if (!commit) throw conflict('commit_failed', 'the commit was created but could not be read back')

      // The row, not `location`: the commit has already landed, and a checkout that vanished
      // underneath it must not turn a success into an error on the way out.
      this.deps.events.emit({ type: 'worktrees-changed', projectId: this.deps.worktrees.row(worktreeId).project_id })
      return commit
    })
  }

  // ---- keeping paths out of commits ----

  private async patternFiles(cwd: string): Promise<{ exclude: string; gitignore: string }> {
    // Not `<git dir>/info/exclude`: a linked worktree's git dir is `.git/worktrees/<name>`, and git
    // reads local excludes from the dir shared by every worktree of the repo. Git knows where that is.
    return { exclude: await gitPathOf(this.deps.repo, cwd, 'info/exclude'), gitignore: join(cwd, '.gitignore') }
  }

  async hidden(worktreeId: string): Promise<HiddenPath[]> {
    const { cwd } = await this.context(worktreeId)
    const files = await this.patternFiles(cwd)
    const [exclude, gitignore, flags] = await Promise.all([
      readIfPresent(files.exclude),
      readIfPresent(files.gitignore),
      this.deps.repo.indexFlags(cwd)
    ])
    const fromPatterns = (contents: string, how: 'exclude' | 'gitignore'): HiddenPath[] =>
      managedPatterns(contents).map((pattern) => ({ path: fromPattern(pattern), how }))
    // skip-worktree paths are absent from both status and diff, so the index flags are the only
    // record that they exist at all.
    const skipped = [...flags].filter(([, letter]) => letter === 'S').map(([path]) => ({ path, how: 'skipWorktree' as const }))
    return [...fromPatterns(exclude, 'exclude'), ...fromPatterns(gitignore, 'gitignore'), ...skipped]
  }

  async exclude(worktreeId: string, input: ExcludeInput): Promise<HiddenPath[]> {
    const { cwd } = await this.context(worktreeId)
    const paths = input.paths.map(repoPath).filter(Boolean)
    const files = await this.patternFiles(cwd)
    if (input.how === 'skipWorktree') await this.locked(cwd, () => this.deps.repo.setSkipWorktree(cwd, paths, true))
    else if (input.how === 'untrack') await this.locked(cwd, () => this.deps.repo.untrackPaths(cwd, paths))
    else {
      const patterns = await Promise.all(paths.map(async (path) => toPattern(path, await isDirectory(cwd, path))))
      await editPatternFile(input.how === 'exclude' ? files.exclude : files.gitignore, (contents) => withPatterns(contents, patterns))
    }
    return this.hidden(worktreeId)
  }

  /** Undoes any of the local mechanisms for the given paths, whichever one is hiding them. */
  async unhide(worktreeId: string, input: UnhideInput): Promise<HiddenPath[]> {
    const { cwd } = await this.context(worktreeId)
    const paths = input.paths.map(repoPath).filter(Boolean)
    const files = await this.patternFiles(cwd)
    const patterns = new Set(paths.flatMap((path) => [toPattern(path, false), toPattern(path, true)]))
    // `--no-skip-worktree` is fatal for a path the index has never heard of, and most paths
    // reaching here are hidden by a pattern file rather than by a flag.
    const flags = await this.deps.repo.indexFlags(cwd)
    const tracked = paths.filter((path) => flags.has(path))
    if (tracked.length > 0) await this.locked(cwd, () => this.deps.repo.setSkipWorktree(cwd, tracked, false))
    for (const file of [files.exclude, files.gitignore]) {
      await editPatternFile(file, (contents) => withoutPatterns(contents, [...patterns]))
    }
    return this.hidden(worktreeId)
  }
}

/** The `-U0` atoms that fall inside one displayed hunk, matched on the old (HEAD) side. */
function atomsOf(atoms: PatchHunk[], hunk: PatchHunk): PatchHunk[] {
  const end = hunk.oldStart + hunk.oldLines
  return atoms.filter((atom) => atom.oldStart >= hunk.oldStart && atom.oldStart <= end)
}

/** Reverses `toPattern`: `/src/foo\[1\].ts` → `src/foo[1].ts`. */
function fromPattern(pattern: string): string {
  return pattern.replace(/^\//, '').replace(/\/$/, '').replace(/\\(.)/g, '$1')
}

async function isDirectory(cwd: string, path: string): Promise<boolean> {
  return (await lstat(join(cwd, path)).catch(() => null))?.isDirectory() ?? false
}

/**
 * The mode a rewritten index entry must carry — the *worktree* mode, so a `chmod +x` is not lost.
 * An untracked path has no status mode yet, so it comes off disk.
 */
async function stageableMode(cwd: string, path: string, entry: StatusEntry | undefined): Promise<string> {
  if (entry && !entry.untracked && entry.mode !== '000000') {
    if (!STAGEABLE_MODES.has(entry.mode)) throw badRequest('unsupported_path', `${path} is not a regular file (mode ${entry.mode})`)
    return entry.mode
  }
  const stats = await lstat(join(cwd, path)).catch(() => null)
  if (!stats || !stats.isFile()) throw badRequest('unsupported_path', `${path} is not a regular file`)
  return stats.mode & 0o111 ? '100755' : '100644'
}
