import { describe, expect, it } from 'vitest'

import { sideSlot, splitProviders } from '../src/components/agent/agent-welcome'

describe('splitProviders', () => {
  const all = ['a', 'b', 'c', 'd', 'e', 'f']

  it('gives every provider a tile while they fit', () => {
    expect(splitProviders(['a', 'b'], 'b')).toEqual({ shown: ['a', 'b'], folded: [] })
  })

  it('folds the rest into the menu, in order', () => {
    expect(splitProviders(all, 'b')).toEqual({ shown: ['a', 'b', 'c', 'd'], folded: ['e', 'f'] })
  })

  it('keeps a folded active provider on screen in the last tile', () => {
    expect(splitProviders(all, 'f')).toEqual({ shown: ['a', 'b', 'c', 'f'], folded: ['d', 'e'] })
  })
})

describe('sideSlot', () => {
  it('fans the unpicked tiles out right, left, right, left', () => {
    expect([0, 1, 2, 3, 4].map(sideSlot)).toEqual([1, -1, 2, -2, 3])
  })
})
