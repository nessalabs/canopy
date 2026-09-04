import { describe, expect, it } from 'vitest'

import { allDirs, flattenTree, pendingDirs, toggled, treeFromPaths, withListing, emptyDir } from '../src/lib/file-tree'

describe('file tree', () => {
  it('builds and flattens a tree from paths, directories first, respecting expansion', () => {
    const root = treeFromPaths(['src/b.ts', 'src/lib/x.ts', 'README.md', 'src/a.ts'])
    expect(allDirs(root)).toEqual(['src', 'src/lib'])
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
})
