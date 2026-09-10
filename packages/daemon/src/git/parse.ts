/**
 * Pure parsers for git's machine-readable outputs. No I/O — every function takes
 * the exact stdout of one command (see repo.ts / diff.ts for the commands).
 */
import type { Branch, ChangedFile, Commit, FileStatus, TreeEntry } from '@canopy/shared'

/** Splits NUL-separated output, dropping the trailing empty field. */
export function splitNul(out: string): string[] {
  const parts = out.split('\0')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

export function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let i = 0; i + size <= items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

const seconds = (unix: string): number => Number(unix) * 1000

/** `git for-each-ref --format=%(refname:short)%00%(objectname:short)%00%(committerdate:unix)%00%(HEAD) refs/heads` */
export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = '', at = '0', head = ''] = line.split('\0')
      return { name, sha, at: seconds(at), current: head.trim() === '*' }
    })
}

export interface WorktreeRecord {
  path: string
  head: string
  /** Short branch name, or null when detached/bare. */
  branch: string | null
  prunable: boolean
}

/** `git worktree list --porcelain -z`: attributes NUL-terminated, records separated by an extra NUL. */
export function parseWorktreeList(out: string): WorktreeRecord[] {
  return out
    .split('\0\0')
    .filter((record) => record.startsWith('worktree '))
    .map((record) => {
      const attrs = new Map(
        splitNul(record).map((line) => {
          const space = line.indexOf(' ')
          return space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]
        })
      )
      const ref = attrs.get('branch')
      return {
        path: attrs.get('worktree') ?? '',
        head: attrs.get('HEAD') ?? '',
        branch: ref ? ref.replace(/^refs\/heads\//, '') : null,
        prunable: attrs.has('prunable')
      }
    })
}

export interface StatusCounts {
  head: string
  branch: string | null
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

/**
 * `git status --porcelain=v2 --branch -z`. Entries are NUL-terminated; rename entries
 * (`2 `) carry the original path as an extra NUL field, which we skip.
 */
export function parsePorcelainV2(out: string): StatusCounts {
  const counts: StatusCounts = { head: '', branch: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
  const fields = splitNul(out)
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? ''
    if (entry.startsWith('# branch.oid ')) counts.head = entry.slice('# branch.oid '.length)
    else if (entry.startsWith('# branch.head ')) {
      const head = entry.slice('# branch.head '.length)
      counts.branch = head === '(detached)' ? null : head
    } else if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      const xy = entry.slice(2, 4)
      if (xy[0] !== '.') counts.staged++
      if (xy[1] !== '.') counts.unstaged++
      if (entry.startsWith('2 ')) i++ // skip the rename source path
    } else if (entry.startsWith('u ')) counts.conflicted++
    else if (entry.startsWith('? ')) counts.untracked++
  }
  return counts
}

/**
 * One path from `git status --porcelain=v2`, keeping what `parsePorcelainV2` throws away.
 * `x`/`y` are the staged and unstaged status letters ('.' for "no change on this side").
 */
export interface StatusEntry {
  path: string
  x: string
  y: string
  untracked: boolean
  conflicted: boolean
  /** Blob ids of the HEAD and index copies; null where that side has no blob. */
  headSha: string | null
  indexSha: string | null
  /**
   * The *worktree* mode (`mW`), which is what a staged entry must carry — using the HEAD mode
   * would silently drop a `chmod +x`. '000000' when the file is gone from disk.
   */
  mode: string
  /** Porcelain v2's submodule field: 'N...' for an ordinary path, 'S...' for a submodule. */
  sub: string
}

const NO_SHA = '0000000000000000000000000000000000000000'
const sha = (value: string | undefined): string | null => (value === undefined || value === NO_SHA ? null : value)

/**
 * `git status --porcelain=v2 -z --no-renames -uall`, per path rather than as counts.
 *
 * `--no-renames` is what keeps this simple: git then reports a rename as an add plus a delete
 * (two `1 ` records) instead of a `2 ` record with a second path field, which also matches the
 * `--no-renames` convention every diff in this daemon already uses. Unmerged (`u `) records carry
 * three stage modes and three stage shas instead of the two of a `1 ` record, so the field offsets
 * differ and the two are parsed apart.
 */
export function parseStatusEntries(out: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  for (const record of splitNul(out)) {
    const kind = record[0]
    if (kind === '?') {
      entries.push({ path: record.slice(2), x: '?', y: '?', untracked: true, conflicted: false, headSha: null, indexSha: null, mode: '', sub: 'N...' })
      continue
    }
    if (kind === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = record.split(' ')
      const xy = fields[1] ?? '..'
      entries.push({
        path: fields.slice(8).join(' '),
        x: xy[0] ?? '.',
        y: xy[1] ?? '.',
        untracked: false,
        conflicted: false,
        headSha: sha(fields[6]),
        indexSha: sha(fields[7]),
        mode: fields[5] ?? '000000',
        sub: fields[2] ?? 'N...'
      })
      continue
    }
    if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = record.split(' ')
      const xy = fields[1] ?? 'UU'
      entries.push({
        path: fields.slice(10).join(' '),
        x: xy[0] ?? 'U',
        y: xy[1] ?? 'U',
        untracked: false,
        conflicted: true,
        headSha: null,
        indexSha: null,
        mode: fields[6] ?? '000000',
        sub: fields[2] ?? 'N...'
      })
    }
    // '#' header lines and anything else carry no path.
  }
  return entries
}

/** The branch `git status --porcelain=v2 --branch` reports; null when detached or unborn. */
export function parseStatusBranch(out: string): string | null {
  for (const record of splitNul(out)) {
    if (!record.startsWith('# branch.head ')) continue
    const head = record.slice('# branch.head '.length)
    return head === '(detached)' ? null : head
  }
  return null
}

/** `git rev-list --left-right --count <base>...HEAD` → `behind\tahead`. */
export function parseAheadBehind(out: string): { ahead: number; behind: number } {
  const [behind = '0', ahead = '0'] = out.trim().split('\t')
  return { ahead: Number(ahead), behind: Number(behind) }
}

export const COMMIT_FORMAT = '%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%P'
const COMMIT_FIELDS = 7

function toCommit([sha = '', shortSha = '', author = '', email = '', at = '0', subject = '', parents = '']: string[]): Commit {
  return { sha, shortSha, author, email, at: seconds(at), subject, parents: parents.split(' ').filter(Boolean) }
}

/**
 * `git log --format=<COMMIT_FORMAT> -z`: each record is NUL-terminated and fields are
 * NUL-separated, so the only safe parse is "split everything, chunk by field count".
 */
export function parseLogZ(out: string): Commit[] {
  return chunk(splitNul(out), COMMIT_FIELDS).map(toCommit)
}

interface Numstat {
  additions: number
  deletions: number
  binary: boolean
}

/** `git diff --numstat -z --no-renames`: `add\tdel\tpath` per NUL-terminated entry; `-\t-` marks binary. */
export function parseNumstat(out: string): Map<string, Numstat> {
  const stats = new Map<string, Numstat>()
  for (const entry of splitNul(out)) {
    const [add = '0', del = '0', ...rest] = entry.split('\t')
    const path = rest.join('\t')
    const binary = add === '-'
    stats.set(path, { additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary })
  }
  return stats
}

/** `git diff --name-status -z --no-renames`: alternating `X`, `path` fields. */
export function parseNameStatus(out: string): Map<string, FileStatus> {
  const statuses = new Map<string, FileStatus>()
  for (const [status = '', path = ''] of chunk(splitNul(out), 2)) {
    statuses.set(path, (status[0] as FileStatus) ?? 'M')
  }
  return statuses
}

/**
 * The index-facing half of a `ChangedFile`, for the diffs that have no index to speak of — a
 * commit, a pair of trees, or the working tree compared against the base branch.
 */
export const UNSTAGED = { staged: 'unstaged', conflicted: false, headSha: null, indexSha: null } as const

/** Joins numstat and name-status on path; files only in one list default to modified/zero. */
export function joinChangedFiles(numstat: Map<string, Numstat>, statuses: Map<string, FileStatus>): ChangedFile[] {
  const paths = [...new Set([...numstat.keys(), ...statuses.keys()])]
  return paths.map((path) => {
    const stat = numstat.get(path) ?? { additions: 0, deletions: 0, binary: false }
    return { path, status: statuses.get(path) ?? 'M', ...stat, ...UNSTAGED }
  })
}

/**
 * Immediate children of `dir` given every file path below it (as `git ls-files` prints
 * them): directories first, then files, each sorted. `dir` is '' for the root.
 */
export function childrenOf(dir: string, paths: string[]): TreeEntry[] {
  const prefix = dir === '' ? '' : `${dir.replace(/\/$/, '')}/`
  const seen = new Map<string, TreeEntry>()
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    const name = slash === -1 ? rest : rest.slice(0, slash)
    if (name === '' || seen.has(name)) continue
    seen.set(name, { name, path: `${prefix}${name}`, kind: slash === -1 ? 'file' : 'dir' })
  }
  const rank = { dir: 0, file: 1 } as const
  return [...seen.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name))
}
