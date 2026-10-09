import { describe, expect, it } from 'vitest'

import { parseChangeMap, partRef } from '../src/lib/change-map'

describe('parseChangeMap', () => {
  it('reads what an agent writes, forgiving a numeric line or badge and a missing edge list', () => {
    const spec = parseChangeMap('{"nodes":[{"id":"a","label":"A","path":"a.ts","lines":42,"status":"modified","badge":3,"extra":1}]}')
    expect(spec).toEqual({ nodes: [{ id: 'a', label: 'A', path: 'a.ts', lines: '42', status: 'modified', badge: '3' }], edges: [] })
    expect(partRef(spec!.nodes[0]!)).toBe('a.ts:42')
  })

  it('is null for half a block, an unknown status or no nodes', () => {
    expect(parseChangeMap('{"nodes":[{"id"')).toBeNull()
    expect(parseChangeMap('{"nodes":[{"id":"a","label":"A","status":"renamed"}]}')).toBeNull()
    expect(parseChangeMap('{"nodes":[]}')).toBeNull()
  })

  it('opens a part by its path alone, or not at all without one', () => {
    expect(partRef({ id: 'a', label: 'A', path: 'a.ts', status: 'added' })).toBe('a.ts')
    expect(partRef({ id: 'c', label: 'Client', status: 'external' })).toBeUndefined()
  })
})

describe('change map helpers', () => {
  it('names a card by its file and folder, and spots a map in an answer', async () => {
    const { hasDrawnBlock, partLabel } = await import('../src/lib/change-map')
    expect(partLabel({ id: 'a', label: 'A', path: 'packages/daemon/src/routes/agents.ts', lines: '22-26', status: 'modified' })).toBe('routes/agents.ts:22-26')
    expect(hasDrawnBlock('Here:\n\n```change-map\n{}\n```')).toBe(true)
    expect(hasDrawnBlock('```change-groups\n{}\n```')).toBe(true)
    expect(hasDrawnBlock('use a `change-map` block')).toBe(false)
  })
})
