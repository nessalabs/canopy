/**
 * Diffs and log for a worktree — the read side of the Git tab. Resolves a
 * client DiffSpec (`against: head|base`) to a revision, then defers to git/diff.ts.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

import type { Against, ChangesResponse, Commit, CommitResponse, DiffSpec, FileContents, FilePatch, LogResponse, TreeResponse, TreesResponse } from '@canopy/shared'

import type { Snapshots } from '../agents/edit-diffs/snapshots'
import { worktreeChanges } from '../commit/status'
import { toFileContents, type DiffReader, type ResolvedDiffSpec } from '../git/diff'
import { childrenOf } from '../git/parse'
import type { Repo } from '../git/repo'
import { badRequest, notFound } from '../lib/errors'
import type { WorktreesService } from './service'

/** How many paths the flat file list hands a client at most. */
const FILE_LIST_LIMIT = 20_000

/** git's well-known empty tree: what an unborn branch is diffed against. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** A repo-relative path that cannot escape the checkout; '' is the root. */
export function repoPath(input: string): string {
  const cleaned = normalize(input).replace(/\/$/, '')
  if (isAbsolute(input) || cleaned === '..' || cleaned.startsWith('../')) throw badRequest('bad_path', `path must stay inside the worktree: ${input}`)
  return cleaned === '.' ? '' : cleaned.replace(/^\.\//, '')
}

interface Deps {
  repo: Repo
  diffs: DiffReader
  worktrees: WorktreesService
  snapshots: Pick<Snapshots, 'take' | 'pin'>
}

export class HistoryService {
  constructor(private readonly deps: Deps) {}

  private async resolve(worktreeId: string, spec: DiffSpec): Promise<{ cwd: string; resolved: ResolvedDiffSpec; baseBranch: string }> {
    // `location`, not `get`: the diff only needs the checkout and its base, and deriving the
    // worktree's status here would spawn three git processes before any diffing starts.
    const { path, baseBranch } = this.deps.worktrees.location(worktreeId)
    if (spec.kind !== 'worktree') return { cwd: path, resolved: spec, baseBranch }
    const wanted = spec.against === 'head' ? 'HEAD' : (await this.deps.repo.mergeBase(path, baseBranch)) ?? 'HEAD'
    // A repo with no commits has no HEAD to diff against; the empty tree makes every file "added".
    const rev = (await this.deps.repo.resolveCommit(path, wanted)) ?? EMPTY_TREE
    return { cwd: path, resolved: { kind: 'worktree', rev }, baseBranch }
  }

  /**
   * The working-tree change as two pinned trees — its base and the checkout as it stands — so a
   * diff of it still reads after the change is committed, pushed or rebased away.
   */
  async snapshot(worktreeId: string, against: Against): Promise<Extract<DiffSpec, { kind: 'trees' }>> {
    const { cwd, resolved } = await this.resolve(worktreeId, { kind: 'worktree', against })
    const [before, after] = await Promise.all([this.deps.snapshots.pin(cwd, (resolved as { rev: string }).rev), this.deps.snapshots.take(cwd)])
    return { kind: 'trees', before, after }
  }

  async changes(worktreeId: string, spec: Extract<DiffSpec, { kind: 'worktree' }>): Promise<ChangesResponse> {
    const { cwd, resolved, baseBranch } = await this.resolve(worktreeId, spec)
    const rev = (resolved as { rev: string }).rev
    // Only the vs-HEAD view can talk about the index: `base` resolves to the merge base, so its
    // rows include work that is already committed and "staged" would mean nothing there.
    if (spec.against === 'base') {
      return { against: spec.against, rev, baseBranch, files: await this.deps.diffs.files(cwd, resolved), branch: null, operation: null }
    }
    const { files, branch, operation } = await worktreeChanges(this.deps.repo, this.deps.diffs, cwd, resolved)
    return { against: spec.against, rev, baseBranch, files, branch, operation }
  }

  async commit(worktreeId: string, sha: string): Promise<CommitResponse> {
    const { cwd, resolved } = await this.resolve(worktreeId, { kind: 'commit', sha })
    const commit = await this.deps.repo.commit(cwd, sha)
    if (!commit) throw notFound('commit', sha)
    return { commit, files: await this.deps.diffs.files(cwd, resolved) }
  }

  /**
   * The tree of a revision, pinned under `refs/canopy/snapshots/` the way a working-tree snapshot
   * is, so a graph cut from commits still reads after a force-push, a rebase or a gc has left them
   * unreachable. Answers the tree sha, which is what a `trees` diff is read between.
   */
  async pinned(worktreeId: string, rev: string): Promise<string> {
    const { path } = this.deps.worktrees.location(worktreeId)
    return this.deps.snapshots.pin(path, rev)
  }

  /**
   * A contiguous run of commits as two pinned trees — the parent of `from` (the empty tree for a
   * root commit) and `to` — and the commits in it, oldest first. Refuses a run that is not one
   * unbroken first-parent line of history. The trees are pinned from the endpoints themselves,
   * never from the ends of the log, so the diff is exactly `from^..to`.
   */
  async commitRange(worktreeId: string, from: string, to: string): Promise<{ spec: Extract<DiffSpec, { kind: 'trees' }>; commits: Commit[] }> {
    const { path } = this.deps.worktrees.location(worktreeId)
    const commits = await this.deps.repo.rangeLog(path, from, to)
    const tip = commits && commits.length > 0 ? await this.deps.repo.resolveCommit(path, to) : null
    if (!commits || !tip) throw badRequest('bad_range', `${from}..${to} is not a run of commits on one line of history`)
    const parent = await this.deps.repo.resolveCommit(path, `${from}^`)
    const [before, after] = await Promise.all([parent ? this.deps.snapshots.pin(path, parent) : EMPTY_TREE, this.deps.snapshots.pin(path, tip)])
    return { spec: { kind: 'trees', before, after }, commits }
  }

  /** Files that differ between two snapshot trees (see agents/edit-diffs). */
  async trees(worktreeId: string, before: string, after: string): Promise<TreesResponse> {
    const { cwd, resolved } = await this.resolve(worktreeId, { kind: 'trees', before, after })
    return { before, after, files: await this.deps.diffs.files(cwd, resolved) }
  }

  async filePatch(worktreeId: string, spec: DiffSpec, path: string): Promise<FilePatch> {
    const { cwd, resolved } = await this.resolve(worktreeId, spec)
    return this.deps.diffs.patch(cwd, resolved, path)
  }

  async tree(worktreeId: string, dir: string): Promise<TreeResponse> {
    const path = repoPath(dir)
    const cwd = this.deps.worktrees.location(worktreeId).path
    return { path, entries: childrenOf(path, await this.deps.repo.lsFiles(cwd, path)) }
  }

  /**
   * Every file in the worktree, flat — tracked and untracked, ignored files left out, the same
   * set the tree walks one directory at a time. Capped so a monorepo cannot hand the client a
   * list no picker could search anyway.
   */
  async files(worktreeId: string): Promise<{ paths: string[]; truncated: boolean }> {
    const cwd = this.deps.worktrees.location(worktreeId).path
    // git hands them back in index order; a picker reads better sorted.
    const paths = (await this.deps.repo.lsFiles(cwd, '')).sort()
    return { paths: paths.slice(0, FILE_LIST_LIMIT), truncated: paths.length > FILE_LIST_LIMIT }
  }

  /** Working-tree contents, or the blob at `rev` when given. */
  async file(worktreeId: string, file: string, rev?: string): Promise<FileContents> {
    const path = repoPath(file)
    const cwd = this.deps.worktrees.location(worktreeId).path
    const raw = rev ? await this.deps.repo.showFile(cwd, rev, path) : await readFile(join(cwd, path), 'utf8').catch(() => null)
    if (raw === null) throw notFound('file', path)
    return toFileContents(path, raw)
  }

  async log(worktreeId: string, limit: number, skip: number): Promise<LogResponse> {
    return this.deps.repo.log(this.deps.worktrees.location(worktreeId).path, limit, skip)
  }
}
