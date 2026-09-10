import { describe, expect, it } from 'vitest'

import { checkStateOf, clickSelection, dirCheckStates, filesUnder, rowsBetween, targetsOf } from '../src/lib/commit-selection'
import { flattenTree, treeFromPaths } from '../src/lib/file-tree'

const root = treeFromPaths(['src/api/a.ts', 'src/api/b.ts', 'src/ui/c.tsx', 'README.md'])
const rows = flattenTree(root, new Set(['src', 'src/api', 'src/ui']))

describe('folder check state', () => {
  const stateFor = (staged: Record<string, 'checked' | 'unchecked' | 'mixed'>) => (path: string) => staged[path] ?? 'unchecked'

  it('is checked only when every file below it is', () => {
    const all = dirCheckStates(root, stateFor({ 'src/api/a.ts': 'checked', 'src/api/b.ts': 'checked' }))
    expect(all.get('src/api')).toBe('checked')
    expect(all.get('src')).toBe('mixed')
    expect(all.get('src/ui')).toBe('unchecked')
    // The root counts README.md too.
    expect(all.get('')).toBe('mixed')
  })

  it('is mixed when any file below it is itself partially staged', () => {
    const states = dirCheckStates(root, stateFor({ 'src/api/a.ts': 'mixed', 'src/api/b.ts': 'checked' }))
    expect(states.get('src/api')).toBe('mixed')
  })

  it('reports an empty directory as unchecked rather than checked', () => {
    expect(dirCheckStates(treeFromPaths([]), () => 'checked').get('')).toBe('unchecked')
  })

  it('maps a file staged state onto a checkbox', () => {
    expect(checkStateOf('staged')).toBe('checked')
    expect(checkStateOf('partial')).toBe('mixed')
    expect(checkStateOf('unstaged')).toBe('unchecked')
  })
})

describe('mouse selection', () => {
  it('replaces the selection on a plain click and moves the anchor', () => {
    const { selected, anchor } = clickSelection(rows, new Set(['README.md']), 'README.md', 'src/api/a.ts', { shift: false, meta: false })
    expect([...selected]).toEqual(['src/api/a.ts'])
    expect(anchor).toBe('src/api/a.ts')
  })

  it('toggles one row with the meta key, leaving the rest alone', () => {
    const added = clickSelection(rows, new Set(['README.md']), 'README.md', 'src/ui/c.tsx', { shift: false, meta: true })
    expect([...added.selected].sort()).toEqual(['README.md', 'src/ui/c.tsx'])
    const removed = clickSelection(rows, added.selected, added.anchor, 'src/ui/c.tsx', { shift: false, meta: true })
    expect([...removed.selected]).toEqual(['README.md'])
  })

  it('extends from the anchor on shift-click and keeps the anchor put', () => {
    const first = clickSelection(rows, new Set(), undefined, 'src/api/a.ts', { shift: false, meta: false })
    const ranged = clickSelection(rows, first.selected, first.anchor, 'src/ui/c.tsx', { shift: true, meta: false })
    expect([...ranged.selected]).toEqual(['src/api/a.ts', 'src/api/b.ts', 'src/ui', 'src/ui/c.tsx'])
    expect(ranged.anchor).toBe('src/api/a.ts')
    // Shrinking the range back measures from the same anchor rather than the last click.
    const shrunk = clickSelection(rows, ranged.selected, ranged.anchor, 'src/api/b.ts', { shift: true, meta: false })
    expect([...shrunk.selected]).toEqual(['src/api/a.ts', 'src/api/b.ts'])
  })

  it('reads a range in either direction and ignores rows that are not visible', () => {
    expect(rowsBetween(rows, 'src/ui/c.tsx', 'src/api/b.ts').map((row) => row.id)).toEqual(['src/api/b.ts', 'src/ui', 'src/ui/c.tsx'])
    expect(rowsBetween(rows, 'README.md', 'nope.ts')).toEqual([])
  })
})

describe('what an action applies to', () => {
  it('expands a directory row to every file beneath it', () => {
    expect(filesUnder(root, 'src')).toEqual(['src/api/a.ts', 'src/api/b.ts', 'src/ui/c.tsx'])
    expect(targetsOf(root, rows, new Set(), 'src/api')).toEqual(['src/api/a.ts', 'src/api/b.ts'])
  })

  it('uses the whole highlight when the clicked row is part of it, and only that row otherwise', () => {
    const selected = new Set(['src/api/a.ts', 'src/ui/c.tsx'])
    expect(targetsOf(root, rows, selected, 'src/api/a.ts')).toEqual(['src/api/a.ts', 'src/ui/c.tsx'])
    expect(targetsOf(root, rows, selected, 'README.md')).toEqual(['README.md'])
  })
})
