import { describe, expect, it } from 'vitest'

import { affectedIn, conceptIndex, conceptsFromAnswer, coverageOf, depthOf, resolveConcepts, resolveConceptLinks, rungsOf, walkConcepts } from '../src/concept-graph'
import { ConceptReply, type HunkIds } from '../src'

const ids: HunkIds = {
  h1: { path: 'a.ts', hunk: 0 },
  h2: { path: 'a.ts', hunk: 1 },
  h3: { path: 'b.ts', hunk: 0 },
  f1: { path: 'c.bin' }
}

const reply = (source: unknown) => ConceptReply.parse(source)

describe('resolveConcepts', () => {
  it('nests as deep as the reply goes, numbering the spine', () => {
    const root = resolveConcepts(
      reply({
        root: {
          title: 'Adds a tool',
          children: [{ title: 'What it is', children: [{ title: 'When it fails', ids: ['h1', 'h2'] }] }, { title: 'How it is served', ids: ['h3', 'f1'] }]
        }
      }),
      ids
    )
    expect(root.id).toBe('root')
    expect(root.children.map((c) => c.id)).toEqual(['1', '2'])
    expect(root.children[0]!.children[0]!.id).toBe('1.1')
    expect(depthOf(root)).toBe(3)
  })

  it('moves a concept\'s own hunks into a Groundwork child once it also has children', () => {
    const root = resolveConcepts(
      reply({ root: { title: 'Root', children: [{ title: 'Has both', ids: ['h1'], children: [{ title: 'Finer', ids: ['h2'] }] }, { title: 'Rest', ids: ['h3', 'f1'] }] } }),
      ids
    )
    const both = root.children[0]!
    // Only leaves own hunks, so a rung can partition the diff exactly once.
    expect(both.owns).toEqual([])
    expect(both.children.map((c) => c.id)).toEqual(['1.0', '1.1'])
    expect(both.children[0]!.title).toBe('Groundwork')
    expect(both.children[0]!.owns).toEqual([ids.h1])
  })

  it('gives every hunk exactly one home, keeping it where it is first claimed', () => {
    const root = resolveConcepts(
      reply({ root: { title: 'Root', children: [{ title: 'First', ids: ['h1', 'h2'] }, { title: 'Second', ids: ['h2', 'h3'] }] } }),
      ids
    )
    const [first, second] = root.children
    expect(first!.owns.map((r) => r.hunk)).toEqual([0, 1])
    // h2 was claimed by "First", so "Second" keeps only h3.
    expect(second!.owns).toEqual([{ path: 'b.ts', hunk: 0 }])
  })

  it('sweeps whatever no concept claimed into a last box, so nothing is hidden', () => {
    const root = resolveConcepts(reply({ root: { title: 'Root', children: [{ title: 'Only this', ids: ['h1'] }] } }), ids)
    const last = root.children.at(-1)!
    expect(last.id).toBe('rest')
    expect(last.owns).toEqual([ids.h2, ids.h3, ids.f1])
    // Every hunk in the diff is reachable from the root, which is what makes the count honest.
    expect(coverageOf(root)).toHaveLength(Object.keys(ids).length)
  })

  it('keeps a concept with no changed code when it names existing paths', () => {
    const root = resolveConcepts(
      reply({ root: { title: 'Root', ids: ['h1', 'h2', 'h3', 'f1'], children: [{ title: 'The toolkit it plugs into', effect: 'context', paths: ['src/toolkit.ts'] }] } }),
      ids
    )
    const context = root.children.find((c) => c.title === 'The toolkit it plugs into')
    expect(context).toBeDefined()
    expect(context!.effect).toBe('context')
    expect(context!.owns).toEqual([])
    expect(context!.paths).toEqual(['src/toolkit.ts'])
  })

  it('drops a concept carrying nothing at all', () => {
    const root = resolveConcepts(reply({ root: { title: 'Root', ids: ['h1', 'h2', 'h3', 'f1'], children: [{ title: 'Empty' }] } }), ids)
    expect(root.children.map((c) => c.title)).not.toContain('Empty')
  })

  it('cites without claiming, and never cites what it already owns', () => {
    const root = resolveConcepts(
      reply({ root: { title: 'Root', children: [{ title: 'Owner', ids: ['h1'], cites: ['h1', 'h2'] }, { title: 'Other', ids: ['h2'] }] } }),
      ids
    )
    const owner = root.children[0]!
    expect(owner.cites).toEqual([ids.h2])
    // Citing h2 did not take it from the concept that owns it.
    expect(root.children[1]!.owns).toEqual([ids.h2])
  })

  it('drops unknown hunk ids rather than inventing refs', () => {
    const root = resolveConcepts(reply({ root: { title: 'Root', ids: ['h1', 'h2', 'h3', 'f1', 'nope'] } }), ids)
    expect(root.owns).toEqual([ids.h1, ids.h2, ids.h3, ids.f1])
  })

  it('moves the root\'s own hunks into Groundwork when the sweep gives it children', () => {
    // The sweep hands the root children it did not have when the leaves-only rule first ran, so
    // the rule is applied again — otherwise the root keeps hunks while having children, and every
    // rung below the top loses them.
    const root = resolveConcepts(reply({ root: { title: 'Root', ids: ['h1'] } }), ids)
    expect(root.owns).toEqual([])
    expect(root.children.map((c) => c.title)).toEqual(['Groundwork', 'Everything else'])
    expect(root.children[0]!.owns).toEqual([ids.h1])
    // Every rung still accounts for the whole diff.
    for (const rung of rungsOf(root)) expect(rung.flatMap(coverageOf)).toHaveLength(Object.keys(ids).length)
  })
})

describe('resolveConceptLinks', () => {
  const built = () => {
    const parsed = reply({
      root: { title: 'Root', children: [{ title: 'Query building', ref: 'queries', ids: ['h1'] }, { title: 'Checkout', ref: 'checkout', effect: 'context', paths: ['src/checkout.ts'] }] },
      links: [
        { from: 'checkout', to: 'queries', kind: 'leans-on', label: 'asks for SQL' },
        { from: '2', to: '1', kind: 'leans-on' },
        { from: 'queries', to: 'queries', kind: 'leans-on' },
        { from: 'ghost', to: 'queries', kind: 'leans-on' }
      ]
    })
    const root = resolveConcepts(parsed, ids)
    return { root, links: resolveConceptLinks(parsed, root) }
  }

  it('resolves either a slug or a position, and drops self, duplicate and unknown links', () => {
    const { links } = built()
    // The slug pair and the positional pair are the same link, so only one survives.
    expect(links).toEqual([{ from: '2', to: '1', kind: 'leans-on', label: 'asks for SQL' }])
  })

  it('finds a concept by slug and by id', () => {
    const index = conceptIndex(built().root)
    expect(index.get('queries')!.id).toBe('1')
    expect(index.get('1')!.title).toBe('Query building')
  })
})

describe('affectedIn', () => {
  it('names unchanged concepts that lean on changed ones, and nothing else', () => {
    const parsed = reply({
      root: {
        title: 'Root',
        children: [
          { title: 'Query building', ref: 'queries', ids: ['h1'] },
          { title: 'Checkout', ref: 'checkout', effect: 'context', paths: ['src/checkout.ts'] },
          { title: 'Reports', ref: 'reports', effect: 'context', paths: ['src/reports.ts'] }
        ]
      },
      links: [
        { from: 'checkout', to: 'queries', kind: 'leans-on' },
        // Leaning on another unchanged concept puts nothing at risk.
        { from: 'reports', to: 'checkout', kind: 'leans-on' }
      ]
    })
    const root = resolveConcepts(parsed, ids)
    const affected = affectedIn(root, resolveConceptLinks(parsed, root))
    expect(affected.map(({ concept }) => concept.title)).toEqual(['Checkout'])
    expect(affected[0]!.because.map((c) => c.title)).toEqual(['Query building'])
  })
})

describe('rungsOf', () => {
  it('keeps every rung a complete account, repeating a branch that stopped refining', () => {
    const root = resolveConcepts(
      reply({ root: { title: 'Root', children: [{ title: 'Deep', ids: ['h1'], children: [{ title: 'Deeper', ids: ['h2'] }] }, { title: 'Shallow', ids: ['h3', 'f1'] }] } }),
      ids
    )
    const rungs = rungsOf(root)
    expect(rungs[0]!.map((c) => c.title)).toEqual(['Root'])
    expect(rungs[1]!.map((c) => c.title)).toEqual(['Deep', 'Shallow'])
    // "Deep" kept a hunk of its own, so it leaves a Groundwork box behind to hold it, and
    // "Shallow" has nothing finer to say, so it repeats rather than dropping out of the rung.
    expect(rungs[2]!.map((c) => c.title)).toEqual(['Groundwork', 'Deeper', 'Shallow'])
    // Which means a rung still covers the whole diff.
    expect(rungs[2]!.flatMap(coverageOf)).toHaveLength(Object.keys(ids).length)
  })
})

describe('conceptsFromAnswer', () => {
  const block = (body: string) => '```concept-graph\n' + body + '\n```'

  it('reads the last map in an answer and pins it to the diff it was made from', () => {
    const text = [
      'First attempt:',
      block(JSON.stringify({ root: { title: 'Old', ids: ['h1'] } })),
      'On reflection:',
      block(JSON.stringify({ root: { title: 'New', ids: ['h1', 'h2', 'h3', 'f1'] } }))
    ].join('\n\n')
    const graph = conceptsFromAnswer(text, ids, 'fp-1', 'deadbeef')
    expect(graph!.root.title).toBe('New')
    expect(graph!.fingerprint).toBe('fp-1')
    expect(graph!.headSha).toBe('deadbeef')
  })

  it('is undefined for an answer holding no map, or a half-written one', () => {
    expect(conceptsFromAnswer('no block here', ids, 'fp-1')).toBeUndefined()
    expect(conceptsFromAnswer(block('{"root": {"title":'), ids, 'fp-1')).toBeUndefined()
  })

  it('walks every concept in reading order', () => {
    const graph = conceptsFromAnswer(block(JSON.stringify({ root: { title: 'Root', children: [{ title: 'A', ids: ['h1'] }, { title: 'B', ids: ['h2'] }] } })), ids, 'fp-1')
    expect(walkConcepts(graph!.root).map((c) => c.title)).toEqual(['Root', 'A', 'B', 'Everything else'])
  })
})
