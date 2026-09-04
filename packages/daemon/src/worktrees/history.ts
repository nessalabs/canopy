/**
 * Diffs and log for a worktree — the read side of the Git Diff tab. Resolves a
 * client DiffSpec (`against: head|base`) to a revision, then defers to git/diff.ts.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

import type { ChangesResponse, CommitResponse, DiffSpec, FileContents, FilePatch, LogResponse, TreeResponse, TreesResponse } from '@canopy/shared'

import { toFileContents, type DiffReader, type ResolvedDiffSpec } from '../git/diff'
import { childrenOf } from '../git/parse'
import type { Repo } from '../git/repo'
import { badRequest, notFound } from '../lib/errors'
import type { WorktreesService } from './service'

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
}

export class HistoryService {
  constructor(private readonly deps: Deps) {}

  private async resolve(worktreeId: string, spec: DiffSpec): Promise<{ cwd: string; resolved: ResolvedDiffSpec; baseBranch: string }> {
    const worktree = await this.deps.worktrees.get(worktreeId)
    if (spec.kind !== 'worktree') return { cwd: worktree.path, resolved: spec, baseBranch: worktree.baseBranch }
    const wanted = spec.against === 'head' ? 'HEAD' : (await this.deps.repo.mergeBase(worktree.path, worktree.baseBranch)) ?? 'HEAD'
    // A repo with no commits has no HEAD to diff against; the empty tree makes every file "added".
    const rev = (await this.deps.repo.resolveCommit(worktree.path, wanted)) ?? EMPTY_TREE
    return { cwd: worktree.path, resolved: { kind: 'worktree', rev }, baseBranch: worktree.baseBranch }
  }

  async changes(worktreeId: string, spec: Extract<DiffSpec, { kind: 'worktree' }>): Promise<ChangesResponse> {
    const { cwd, resolved, baseBranch } = await this.resolve(worktreeId, spec)
    return { against: spec.against, rev: (resolved as { rev: string }).rev, baseBranch, files: await this.deps.diffs.files(cwd, resolved) }
  }

  async commit(worktreeId: string, sha: string): Promise<CommitResponse> {
    const { cwd, resolved } = await this.resolve(worktreeId, { kind: 'commit', sha })
    const commit = await this.deps.repo.commit(cwd, sha)
    if (!commit) throw notFound('commit', sha)
    return { commit, files: await this.deps.diffs.files(cwd, resolved) }
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
    const worktree = await this.deps.worktrees.get(worktreeId)
    return { path, entries: childrenOf(path, await this.deps.repo.lsFiles(worktree.path, path)) }
  }

  /** Working-tree contents, or the blob at `rev` when given. */
  async file(worktreeId: string, file: string, rev?: string): Promise<FileContents> {
    const path = repoPath(file)
    const worktree = await this.deps.worktrees.get(worktreeId)
    const raw = rev ? await this.deps.repo.showFile(worktree.path, rev, path) : await readFile(join(worktree.path, path), 'utf8').catch(() => null)
    if (raw === null) throw notFound('file', path)
    return toFileContents(path, raw)
  }

  async log(worktreeId: string, limit: number, skip: number): Promise<LogResponse> {
    const worktree = await this.deps.worktrees.get(worktreeId)
    return this.deps.repo.log(worktree.path, limit, skip)
  }
}
