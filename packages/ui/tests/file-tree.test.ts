import { describe, expect, it } from 'vitest'

import { defaultOpenDirs, dirTotals, flattenTree, pendingDirs, toggled, treeFromPaths, withListing, emptyDir } from '../src/lib/file-tree'

describe('file tree', () => {
  it('builds and flattens a tree from paths, directories first, respecting expansion', () => {
    const root = treeFromPaths(['src/b.ts', 'src/lib/x.ts', 'README.md', 'src/a.ts'])
    expect(defaultOpenDirs(root)).toEqual(['src', 'src/lib'])
    const open = flattenTree(root, new Set(['src', 'src/lib']))
    expect(open.map((r) => `${r.depth}:${r.kind}:${r.id}`)).toEqual([
      '0:dir:src',
      '1:dir:src/lib',
      '2:file:src/lib/x.ts',
      '1:file:src/a.ts',
      '1:file:src/b.ts',
      '0:file:README.md'
    ])
    expect(flattenTree(root, new Set()).map((r) => r.id)).toEqual(['src', 'README.md'])
  })

  it('merges lazy listings immutably and reports what still needs fetching', () => {
    const root = emptyDir()
    const expanded = new Set(['src'])
    expect(pendingDirs(root, expanded)).toEqual(['', 'src'])
    const withRoot = withListing(root, '', [
      { name: 'src', path: 'src', kind: 'dir' },
      { name: 'package.json', path: 'package.json', kind: 'file' }
    ])
    expect(root.loaded).toBe(false)
    expect(pendingDirs(withRoot, expanded)).toEqual(['src'])
    expect(flattenTree(withRoot, expanded)[0]).toMatchObject({ id: 'src', loading: true })
    const withSrc = withListing(withRoot, 'src', [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }])
    expect(pendingDirs(withSrc, expanded)).toEqual([])
    expect(flattenTree(withSrc, expanded).map((r) => r.id)).toEqual(['src', 'src/index.ts', 'package.json'])
    expect(toggled(expanded, 'src').has('src')).toBe(false)
  })

  it('leaves hidden folders and their contents collapsed by default', () => {
    const root = treeFromPaths(['.worktrees/feat/src/a.ts', '.github/workflows/ci.yml', 'src/a.ts'])
    expect(defaultOpenDirs(root)).toEqual(['src'])
    expect(flattenTree(root, new Set(defaultOpenDirs(root))).map((r) => r.id)).toEqual(['.github', '.worktrees', 'src', 'src/a.ts'])
  })

  it('rolls per-file amounts up into every directory, at any depth', () => {
    const root = treeFromPaths(['src/a.ts', 'src/lib/x.ts', 'src/lib/deep/y.ts', 'README.md'])
    const amounts: Record<string, { additions: number; deletions: number; comments: number }> = {
      'src/a.ts': { additions: 1, deletions: 2, comments: 1 },
      'src/lib/x.ts': { additions: 10, deletions: 20, comments: 0 },
      'src/lib/deep/y.ts': { additions: 100, deletions: 200, comments: 3 }
    }
    const totals = dirTotals(root, (path) => amounts[path])
    expect(totals.get('src/lib/deep')).toEqual({ files: 1, additions: 100, deletions: 200, comments: 3 })
    expect(totals.get('src/lib')).toEqual({ files: 2, additions: 110, deletions: 220, comments: 3 })
    expect(totals.get('src')).toEqual({ files: 3, additions: 111, deletions: 222, comments: 4 })
    // README.md has no amounts, so it counts as a file and nothing else.
    expect(totals.get('')).toEqual({ files: 4, additions: 111, deletions: 222, comments: 4 })
  })
})
