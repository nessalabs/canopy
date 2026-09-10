/**
 * Pure tree model behind the file browsers: a nested directory structure built from paths
 * (changed files) or from lazily fetched directory listings (the whole worktree), and the
 * flattening that turns "which directories are open" into the rows a TreeView renders.
 */
import type { TreeEntry } from '@canopy/shared'

export interface TreeDir {
  path: string
  /** Child directories by name; `undefined` children means "not fetched yet". */
  dirs: Map<string, TreeDir>
  files: Map<string, string>
  loaded: boolean
}

export interface FlatRow {
  /** The repo-relative path; doubles as the row id. */
  id: string
  name: string
  depth: number
  kind: 'dir' | 'file'
  expanded: boolean
  /** A directory that is open but whose children have not arrived. */
  loading: boolean
}

export const emptyDir = (path = ''): TreeDir => ({ path, dirs: new Map(), files: new Map(), loaded: false })

const childPath = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

/** Walks (creating) the directory chain for `dir` and returns it. Mutates `root`; callers copy first. */
function ensureDir(root: TreeDir, dir: string): TreeDir {
  let node = root
  for (const name of dir === '' ? [] : dir.split('/')) {
    const next = node.dirs.get(name) ?? emptyDir(childPath(node.path, name))
    node.dirs.set(name, next)
    node = next
  }
  return node
}

/** A complete tree for a known set of file paths (the changed-files list). */
export function treeFromPaths(paths: readonly string[]): TreeDir {
  const root = emptyDir()
  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const dir = ensureDir(root, slash === -1 ? '' : path.slice(0, slash))
    dir.files.set(path.slice(slash + 1), path)
    dir.loaded = true
  }
  markLoaded(root)
  return root
}

function markLoaded(dir: TreeDir): void {
  dir.loaded = true
  dir.dirs.forEach(markLoaded)
}

/** Copies the chain of directories down to `dir` so an update never mutates a rendered tree. */
function cloneChain(root: TreeDir, dir: string): { root: TreeDir; target: TreeDir } {
  const copy = { ...root, dirs: new Map(root.dirs) }
  let node = copy
  for (const name of dir === '' ? [] : dir.split('/')) {
    const child = node.dirs.get(name) ?? emptyDir(childPath(node.path, name))
    const next = { ...child, dirs: new Map(child.dirs) }
    node.dirs.set(name, next)
    node = next
  }
  return { root: copy, target: node }
}

/** Returns a new tree with one fetched directory listing merged in (the lazy, whole-worktree mode). */
export function withListing(root: TreeDir, dir: string, entries: readonly TreeEntry[]): TreeDir {
  const { root: next, target } = cloneChain(root, dir)
  target.loaded = true
  target.files = new Map(entries.filter((e) => e.kind === 'file').map((e) => [e.name, e.path]))
  for (const entry of entries.filter((e) => e.kind === 'dir')) {
    if (!target.dirs.has(entry.name)) target.dirs.set(entry.name, emptyDir(entry.path))
  }
  return next
}

/**
 * The directories the changed-files tree starts open: everything except hidden
 * folders (`.worktrees`, `.github`, ...) and anything inside them, which stay
 * collapsed until asked for.
 */
export function defaultOpenDirs(root: TreeDir): string[] {
  const out: string[] = []
  const walk = (dir: TreeDir): void => {
    for (const [name, child] of dir.dirs) {
      if (name.startsWith('.')) continue
      out.push(child.path)
      walk(child)
    }
  }
  walk(root)
  return out
}

const byName = (a: [string, unknown], b: [string, unknown]): number => a[0].localeCompare(b[0])

/** Rows for the open directories only, directories before files at each level. */
export function flattenTree(root: TreeDir, expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = []
  const walk = (dir: TreeDir, depth: number): void => {
    for (const [name, child] of [...dir.dirs].sort(byName)) {
      const open = expanded.has(child.path)
      rows.push({ id: child.path, name, depth, kind: 'dir', expanded: open, loading: open && !child.loaded })
      if (open) walk(child, depth + 1)
    }
    for (const [name, path] of [...dir.files].sort(byName)) {
      rows.push({ id: path, name, depth, kind: 'file', expanded: false, loading: false })
    }
  }
  walk(root, 0)
  return rows
}

/** Directories that need fetching: open, but not loaded. */
export const pendingDirs = (root: TreeDir, expanded: ReadonlySet<string>): string[] =>
  ['', ...expanded].filter((dir) => !ensureLoaded(root, dir))

function ensureLoaded(root: TreeDir, dir: string): boolean {
  let node: TreeDir | undefined = root
  for (const name of dir === '' ? [] : dir.split('/')) node = node?.dirs.get(name)
  return node?.loaded ?? false
}

/** Toggles one id in a set, immutably. */
export function toggled<T>(set: ReadonlySet<T>, id: T): Set<T> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** What a directory row reports for everything beneath it. */
export interface DirTotals {
  files: number
  additions: number
  deletions: number
  comments: number
}

/**
 * Totals for every directory in the tree, summed over all files below it at any depth.
 * `amountsFor` supplies one file's numbers; a file it does not know contributes only to
 * the count. Keyed by directory path, with the root under `''`.
 */
export function dirTotals(
  root: TreeDir,
  amountsFor: (path: string) => { additions?: number; deletions?: number; comments?: number } | undefined
): Map<string, DirTotals> {
  const totals = new Map<string, DirTotals>()
  const walk = (dir: TreeDir): DirTotals => {
    const sum: DirTotals = { files: 0, additions: 0, deletions: 0, comments: 0 }
    for (const child of dir.dirs.values()) {
      const below = walk(child)
      sum.files += below.files
      sum.additions += below.additions
      sum.deletions += below.deletions
      sum.comments += below.comments
    }
    for (const path of dir.files.values()) {
      const amounts = amountsFor(path)
      sum.files += 1
      sum.additions += amounts?.additions ?? 0
      sum.deletions += amounts?.deletions ?? 0
      sum.comments += amounts?.comments ?? 0
    }
    totals.set(dir.path, sum)
    return sum
  }
  walk(root)
  return totals
}
