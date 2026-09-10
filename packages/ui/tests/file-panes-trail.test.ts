import { describe, expect, it } from 'vitest'

import { followLink, liveTrail } from '@/components/git/file-panes'

describe('file pane trail', () => {
  it('goes back to the file a link was followed from, not the file opened before it', () => {
    // README → link to A, Back, then link to B: Back must return to README, not A.
    let trail = followLink(undefined, 'README.md', 'docs/a.md', 'intro')
    expect(trail.map((stop) => stop.path)).toEqual(['README.md', 'docs/a.md'])
    trail = trail.slice(0, -1) // Back
    trail = followLink(trail, 'README.md', 'docs/b.md')
    expect(trail.map((stop) => stop.path)).toEqual(['README.md', 'docs/b.md'])
    expect(liveTrail(trail, 'docs/b.md')?.at(-2)?.path).toBe('README.md')
  })

  it('carries the heading a link named, and forgets it on the way back', () => {
    const trail = followLink(undefined, 'README.md', 'docs/a.md', 'setup')
    expect(liveTrail(trail, 'docs/a.md')?.at(-1)?.hash).toBe('setup')
    expect(liveTrail(trail.slice(0, -1), 'README.md')?.at(-1)?.hash).toBeUndefined()
  })

  it('leaves the trail behind once the tree picks a different file', () => {
    const trail = followLink(undefined, 'README.md', 'docs/a.md')
    expect(liveTrail(trail, 'src/index.ts')).toBeUndefined()
    // A link followed from the newly picked file starts over from there.
    expect(followLink(trail, 'src/index.ts', 'docs/c.md').map((stop) => stop.path)).toEqual(['src/index.ts', 'docs/c.md'])
  })
})
