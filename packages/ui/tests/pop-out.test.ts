// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { diagramWindowHash, fileWindowHash, fileWindowParams, readDiagram, stashDiagram } from '../src/lib/pop-out'

/** What the `/window/file/:worktreeId/:rev/*` route hands the screen, given a built hash. */
function routeParams(hash: string): { worktreeId: string; rev: string; path: string } {
  const [, , , worktreeId, rev, ...rest] = hash.split('/')
  return { worktreeId: worktreeId ?? '', rev: rev ?? '', path: rest.join('/') }
}

describe('file windows', () => {
  it('round-trips a path through the route, slashes intact', () => {
    const hash = fileWindowHash('wt-1', 'docs/evaluation/synthesizer/README.md')
    expect(hash).toBe('/window/file/wt-1/-/docs/evaluation/synthesizer/README.md')
    const { worktreeId, rev, path } = routeParams(hash)
    expect(fileWindowParams(worktreeId, rev, path)).toEqual({ worktreeId: 'wt-1', rev: undefined, path: 'docs/evaluation/synthesizer/README.md' })
  })

  it('carries the commit a file was read at', () => {
    const hash = fileWindowHash('wt-1', 'README.md', 'a4d0600')
    const { worktreeId, rev, path } = routeParams(hash)
    expect(fileWindowParams(worktreeId, rev, path)).toEqual({ worktreeId: 'wt-1', rev: 'a4d0600', path: 'README.md' })
  })

  it('survives a path the URL would otherwise mangle', () => {
    const path = 'docs/plans/agent turn snapshots.md'
    const { worktreeId, rev, path: decoded } = routeParams(fileWindowHash('wt 2', path))
    expect(fileWindowParams(worktreeId, rev, decoded).path).toBe(path)
    expect(fileWindowParams(worktreeId, rev, decoded).worktreeId).toBe('wt 2')
  })
})

describe('diagram windows', () => {
  beforeEach(() => localStorage.clear())

  it('hands one diagram to the window opened for it', () => {
    const chart = 'flowchart TD\n  A[Verification UI] --> B[Run control]'
    const key = stashDiagram(chart)
    expect(diagramWindowHash(key)).toBe(`/window/diagram/${key}`)
    expect(readDiagram(key)).toBe(chart)
  })

  it('says so when the diagram is gone rather than drawing nothing', () => {
    expect(readDiagram('never-stashed')).toBeNull()
  })

  it('drops diagrams older than a day, so storage cannot fill up', () => {
    const stale = stashDiagram('flowchart TD\n  A --> B')
    localStorage.setItem(`canopy:diagram:${stale}`, JSON.stringify({ chart: 'flowchart TD\n  A --> B', at: Date.now() - 25 * 60 * 60 * 1000 }))
    const fresh = stashDiagram('flowchart TD\n  C --> D')
    expect(readDiagram(stale)).toBeNull()
    expect(readDiagram(fresh)).toBe('flowchart TD\n  C --> D')
  })
})
