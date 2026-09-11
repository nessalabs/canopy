/**
 * Read/write operations on a git checkout. Thin: each function is one git command
 * plus a parser from parse.ts. `run` is injected so tests can observe or stub calls.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Branch, Commit } from '@canopy/shared'

import type { GitRunner } from './exec'
import {
  COMMIT_FORMAT,
  parseAheadBehind,
  parseBranches,
  parseCherryApplied,
  parseLogZ,
  parsePorcelainV2,
  parseRefTips,
  parseStatusBranch,
  parseStatusEntries,
  parseWorktreeList,
  splitNul,
  type StatusCounts,
  type StatusEntry,
  type WorktreeRecord
} from './parse'

export interface Repo {
  toplevel(path: string): Promise<string | null>
  listBranches(repo: string): Promise<Branch[]>
  defaultBranch(repo: string, branches: Branch[]): Promise<string>
  worktreeList(repo: string): Promise<WorktreeRecord[]>
  status(cwd: string): Promise<StatusCounts>
  aheadBehind(cwd: string, base: string): Promise<{ ahead: number; behind: number } | null>
  lastCommit(cwd: string): Promise<Commit | null>
  mergeBase(cwd: string, base: string): Promise<string | null>
  /** The tips of whichever of `refs` (full names) exist; one cheap process, no object walk. */
  refTips(cwd: string, refs: string[]): Promise<{ ref: string; sha: string }[]>
  /** Which of `refs` (full names) have `rev` in their history. */
  refsContaining(cwd: string, rev: string, refs: string[]): Promise<string[]>
  /** `git cherry`: true when every commit of `head` not in `upstream` has an equivalent patch there. */
  cherryApplied(cwd: string, upstream: string, head: string): Promise<boolean>
  /** A dangling commit with `tree`'s content on `parent` — one patch standing for a whole branch. */
  commitTree(cwd: string, tree: string, parent: string, message: string): Promise<string>
  /** The commit a revision names, or null when it does not exist (e.g. HEAD on an unborn branch). */
  resolveCommit(cwd: string, rev: string): Promise<string | null>
  log(cwd: string, limit: number, skip: number): Promise<{ commits: Commit[]; hasMore: boolean }>
  commit(cwd: string, sha: string): Promise<Commit | null>
  /** Untracked, non-ignored files; scoped to `path` when given, which answers "is this one new?". */
  untracked(cwd: string, path?: string): Promise<string[]>
  /** Every tracked or untracked (not ignored) file under `dir`; '' for the whole tree. */
  lsFiles(cwd: string, dir: string): Promise<string[]>
  /** A file's blob at `rev`, or null when it does not exist there. */
  showFile(cwd: string, rev: string, path: string): Promise<string | null>
  worktreeAdd(repo: string, path: string, branch: { mode: 'new'; name: string; base: string } | { mode: 'existing'; name: string }): Promise<void>
  worktreeRemove(repo: string, path: string, force: boolean): Promise<void>
  /**
   * Everything in a working tree, tracked and untracked, saved as one commit under `ref`.
   * The message is built from the file count, which is only known once the tree is written.
   */
  snapshotWorkingTree(cwd: string, ref: string, message: (files: number) => string): Promise<{ sha: string; files: number } | null>
  /** Every ref under `prefix`, newest first, with the commit each points at and its message. */
  refsUnder(cwd: string, prefix: string): Promise<Array<{ ref: string; sha: string; at: number; message: string }>>
  deleteRef(cwd: string, ref: string): Promise<void>
  /** What changed between two commits, as `status\tpath` pairs. */
  changedPaths(cwd: string, from: string, to: string): Promise<Array<{ status: string; path: string }>>
  /** Writes every path of `sha` into the working tree, leaving the index alone. */
  restoreFrom(cwd: string, sha: string): Promise<void>

  // ---- the index: everything the commit panel's checkboxes drive ----
  /** Every path git has something to say about, plus the branch, from one `status` call. */
  statusEntries(cwd: string): Promise<{ entries: StatusEntry[]; branch: string | null }>
  /** Resolves a path inside the worktree's git dir (`MERGE_HEAD`, …). Linked-worktree aware. */
  gitPath(cwd: string, name: string): Promise<string>
  /** The worktree's own git dir (index, HEAD) and the repository's common dir (refs), absolute. */
  gitDirs(cwd: string): Promise<{ gitDir: string; commonDir: string }>
  /** Which of `paths` git ignores; tracked files never count as ignored. */
  checkIgnore(cwd: string, paths: string[]): Promise<Set<string>>
  /** A blob's bytes as a latin1 string — a byte-exact round trip, unlike a utf8 decode. */
  catBlob(cwd: string, sha: string): Promise<string>
  /** Writes `content` (latin1) as a blob, applying the clean filters configured for `path`. */
  writeBlob(cwd: string, path: string, content: string): Promise<string>
  /** Points the index entry for `path` at `sha`; `--add` covers a path git does not know yet. */
  updateIndexEntry(cwd: string, mode: string, sha: string, path: string): Promise<void>
  /** Records a deletion in the index, which `--cacheinfo` cannot express. */
  removeIndexEntry(cwd: string, path: string): Promise<void>
  stagePaths(cwd: string, paths: string[]): Promise<void>
  /** Restores the HEAD entry for each path; on an unborn branch there is none, so it removes. */
  unstagePaths(cwd: string, paths: string[], hasHead: boolean): Promise<void>
  /** `git rm --cached`: stops tracking a path while leaving it on disk. */
  untrackPaths(cwd: string, paths: string[]): Promise<void>
  setSkipWorktree(cwd: string, paths: string[], skip: boolean): Promise<void>
  /** `ls-files -v`: the per-path flag letter, where 'S' marks skip-worktree. */
  indexFlags(cwd: string): Promise<Map<string, string>>
  /** The staged tree as a commit. Returns the new sha. */
  commitIndex(cwd: string, message: string, options: { noVerify: boolean; timeout: number }): Promise<string>
}

const WORKTREE_ADD_ARGS = {
  new: (path: string, b: { name: string; base: string }) => ['worktree', 'add', '-b', b.name, path, b.base],
  existing: (path: string, b: { name: string }) => ['worktree', 'add', path, b.name]
} as const

/** Paths for `--pathspec-from-file=- --pathspec-file-nul`: NUL-separated, no shell, no ARG_MAX. */
const nulList = (paths: string[]): string => paths.map((path) => `${path}\0`).join('')

export function createRepo(run: GitRunner): Repo {
  const tryRun = async (cwd: string, args: string[]): Promise<string | null> => {
    try {
      return await run(cwd, args)
    } catch {
      return null
    }
  }

  return {
    async toplevel(path) {
      const out = await tryRun(path, ['rev-parse', '--show-toplevel'])
      return out?.trim() || null
    },

    async listBranches(repo) {
      const out = await run(repo, [
        'for-each-ref',
        '--format=%(refname:short)%00%(objectname:short)%00%(committerdate:unix)%00%(HEAD)',
        'refs/heads'
      ])
      return parseBranches(out)
    },

    async defaultBranch(repo, branches) {
      const upstream = await tryRun(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      const fromUpstream = upstream?.trim().replace(/^origin\//, '')
      const names = new Set(branches.map((b) => b.name))
      return [fromUpstream, 'main', 'master'].find((name) => name && names.has(name)) ?? branches[0]?.name ?? 'main'
    },

    async worktreeList(repo) {
      return parseWorktreeList(await run(repo, ['worktree', 'list', '--porcelain', '-z']))
    },

    async status(cwd) {
      return parsePorcelainV2(await run(cwd, ['status', '--porcelain=v2', '--branch', '-z']))
    },

    async aheadBehind(cwd, base) {
      const out = await tryRun(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
      return out === null ? null : parseAheadBehind(out)
    },

    async lastCommit(cwd) {
      const out = await tryRun(cwd, ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`])
      return out ? parseLogZ(out)[0] ?? null : null
    },

    async resolveCommit(cwd, rev) {
      const out = await tryRun(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
      return out?.trim() || null
    },

    async mergeBase(cwd, base) {
      const out = await tryRun(cwd, ['merge-base', base, 'HEAD'])
      return out?.trim() || null
    },

    async refTips(cwd, refs) {
      return parseRefTips(await run(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', ...refs]))
    },

    async refsContaining(cwd, rev, refs) {
      const out = await tryRun(cwd, ['for-each-ref', '--contains', rev, '--format=%(refname)', ...refs])
      return out === null ? [] : out.split('\n').filter(Boolean)
    },

    async cherryApplied(cwd, upstream, head) {
      const out = await tryRun(cwd, ['cherry', upstream, head])
      return out !== null && parseCherryApplied(out)
    },

    async commitTree(cwd, tree, parent, message) {
      return (await run(cwd, ['commit-tree', tree, '-p', parent, '-m', message])).trim()
    },

    async log(cwd, limit, skip) {
      if (!(await this.resolveCommit(cwd, 'HEAD'))) return { commits: [], hasMore: false }
      const out = await run(cwd, ['log', '-z', `--format=${COMMIT_FORMAT}`, '-n', String(limit + 1), '--skip', String(skip), 'HEAD'])
      const commits = parseLogZ(out)
      return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
    },

    async commit(cwd, sha) {
      const out = await tryRun(cwd, ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`, sha, '--'])
      return out ? parseLogZ(out)[0] ?? null : null
    },

    async untracked(cwd, path) {
      return splitNul(await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...(path === undefined ? [] : ['--', path])]))
    },

    async lsFiles(cwd, dir) {
      return splitNul(await run(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir === '' ? '.' : dir]))
    },

    async showFile(cwd, rev, path) {
      return tryRun(cwd, ['show', `${rev}:${path}`])
    },

    async statusEntries(cwd) {
      // --no-renames is what keeps these entries one-to-one with the --no-renames diffs the rest
      // of the daemon takes; without it a rename is one status record but two diff records.
      const out = await run(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--no-renames', '--untracked-files=all'])
      return { entries: parseStatusEntries(out), branch: parseStatusBranch(out) }
    },

    async gitPath(cwd, name) {
      return (await run(cwd, ['rev-parse', '--git-path', name])).trim()
    },

    async gitDirs(cwd) {
      // Both come back relative to cwd for the main worktree and absolute for a linked one.
      const [gitDir = '.git', commonDir = gitDir] = (await run(cwd, ['rev-parse', '--git-dir', '--git-common-dir'])).split('\n').map((line) => line.trim())
      return { gitDir: resolve(cwd, gitDir), commonDir: resolve(cwd, commonDir) }
    },

    async checkIgnore(cwd, paths) {
      if (paths.length === 0) return new Set()
      // Exit 1 means "none of them", which is an answer, not a failure. check-ignore takes
      // plain paths and refuses the literal-pathspec mode the runner sets, so that is undone here.
      return new Set(splitNul(await run(cwd, ['check-ignore', '-z', '--stdin'], { input: paths.join('\0'), okCodes: [0, 1], env: { GIT_LITERAL_PATHSPECS: '0' } })))
    },

    async catBlob(cwd, sha) {
      return run(cwd, ['cat-file', 'blob', sha], { binary: true })
    },

    async writeBlob(cwd, path, content) {
      // --path is not cosmetic: it applies the clean filters (.gitattributes, autocrlf) that the
      // blob would get through `git add`, so a partially staged file matches byte for byte.
      const out = await run(cwd, ['hash-object', '-w', '--stdin', '--path', path], { input: Buffer.from(content, 'latin1'), binary: true })
      return out.trim()
    },

    async updateIndexEntry(cwd, mode, sha, path) {
      await run(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`])
    },

    async removeIndexEntry(cwd, path) {
      await run(cwd, ['update-index', '--force-remove', '--', path])
    },

    async stagePaths(cwd, paths) {
      if (paths.length === 0) return
      await run(cwd, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths) })
    },

    async unstagePaths(cwd, paths, hasHead) {
      if (paths.length === 0) return
      const args = hasHead
        ? ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul']
        : ['rm', '--cached', '--quiet', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul']
      await run(cwd, args, { input: nulList(paths) })
    },

    async untrackPaths(cwd, paths) {
      if (paths.length === 0) return
      await run(cwd, ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths) })
    },

    async setSkipWorktree(cwd, paths, skip) {
      if (paths.length === 0) return
      // update-index predates --pathspec-from-file and rejects it; its stdin form is `-z --stdin`.
      await run(cwd, ['update-index', skip ? '--skip-worktree' : '--no-skip-worktree', '-z', '--stdin'], { input: nulList(paths) })
    },

    async indexFlags(cwd) {
      const flags = new Map<string, string>()
      for (const line of splitNul(await run(cwd, ['ls-files', '-v', '-z']))) {
        const letter = line[0]
        if (letter === undefined) continue
        flags.set(line.slice(2), letter)
      }
      return flags
    },

    async commitIndex(cwd, message, { noVerify, timeout }) {
      await run(cwd, ['commit', '--file=-', '--cleanup=whitespace', ...(noVerify ? ['--no-verify'] : [])], {
        input: message,
        timeout,
        // Signing without a cached passphrase would otherwise sit on a pinentry prompt forever.
        env: { GIT_TERMINAL_PROMPT: '0' }
      })
      return (await run(cwd, ['rev-parse', 'HEAD'])).trim()
    },

    async worktreeAdd(repo, path, branch) {
      const args = branch.mode === 'new' ? WORKTREE_ADD_ARGS.new(path, branch) : WORKTREE_ADD_ARGS.existing(path, branch)
      await run(repo, args)
    },

    async worktreeRemove(repo, path, force) {
      await run(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
      await run(repo, ['worktree', 'prune'])
    },

    async refsUnder(cwd, prefix) {
      // One call for the lot: a record per ref, fields NUL-separated, the message last because
      // it is the only one that can contain newlines.
      const out = await run(cwd, ['for-each-ref', '--sort=-committerdate', `--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(contents)%01`, prefix])
      return out
        .split('\x01')
        .map((record) => record.replace(/^\n/, ''))
        .filter((record) => record.trim() !== '')
        .map((record) => {
          const [ref = '', sha = '', at = '0', ...rest] = record.split('\0')
          return { ref, sha, at: Number(at) * 1000, message: rest.join('\0') }
        })
    },

    async deleteRef(cwd, ref) {
      await run(cwd, ['update-ref', '-d', ref])
    },

    async changedPaths(cwd, from, to) {
      const fields = splitNul(await run(cwd, ['diff', '--name-status', '-z', from, to]))
      // `-z` emits status and path as separate records, in pairs.
      const pairs: Array<{ status: string; path: string }> = []
      for (let i = 0; i + 1 < fields.length; i += 2) pairs.push({ status: fields[i] ?? '', path: fields[i + 1] ?? '' })
      return pairs
    },

    async restoreFrom(cwd, sha) {
      await run(cwd, ['restore', '--source', sha, '--worktree', '--', '.'])
    },

    async snapshotWorkingTree(cwd, ref, message) {
      // A throwaway index, so the real one is untouched: seed it from HEAD and add everything
      // the working tree has. `add -A` takes modifications, deletions and untracked files and
      // leaves what git ignores, which is exactly what would be lost with the checkout.
      const index = join(await mkdtemp(join(tmpdir(), 'canopy-salvage-')), 'index')
      const env = { GIT_INDEX_FILE: index }
      try {
        const head = await this.resolveCommit(cwd, 'HEAD')
        if (head) await run(cwd, ['read-tree', head], { env })
        await run(cwd, ['add', '-A'], { env })
        const tree = (await run(cwd, ['write-tree'], { env })).trim()
        // Nothing to save: the working tree is the commit it is sitting on.
        if (head && tree === (await run(cwd, ['rev-parse', `${head}^{tree}`])).trim()) return null
        const files = splitNul(await run(cwd, ['diff', '--name-only', '-z', ...(head ? [head] : ['--cached']), '--', '.'], { env })).length
        // An identity of our own: a repository with none configured must still be able to save.
        const sha = (
          await run(cwd, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message(files)], {
            env: { ...env, GIT_AUTHOR_NAME: 'Canopy', GIT_AUTHOR_EMAIL: 'canopy@localhost', GIT_COMMITTER_NAME: 'Canopy', GIT_COMMITTER_EMAIL: 'canopy@localhost' }
          })
        ).trim()
        // The ref lives in the repository, not the worktree, so it outlives the checkout and
        // keeps the commit from being collected.
        await run(cwd, ['update-ref', ref, sha])
        return { sha, files }
      } finally {
        await rm(dirname(index), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}
