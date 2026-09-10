import { describe, expect, it } from 'vitest'

import { resolveDocLink, slugify } from '../src/lib/doc-links'

const from = 'docs/specs/README.md'

describe('doc links', () => {
  it('resolves a link against the directory of the doc holding it', () => {
    expect(resolveDocLink(from, 'S06-generator-adapter.md')).toEqual({ kind: 'file', path: 'docs/specs/S06-generator-adapter.md', hash: undefined })
    expect(resolveDocLink(from, './notes/a.md')).toEqual({ kind: 'file', path: 'docs/specs/notes/a.md', hash: undefined })
    expect(resolveDocLink(from, '../ARCHITECTURE.md')).toEqual({ kind: 'file', path: 'docs/ARCHITECTURE.md', hash: undefined })
    expect(resolveDocLink(from, '/README.md')).toEqual({ kind: 'file', path: 'README.md', hash: undefined })
  })

  it('carries a fragment along, and drops a query string', () => {
    expect(resolveDocLink(from, '../ARCHITECTURE.md#the-layers')).toEqual({ kind: 'file', path: 'docs/ARCHITECTURE.md', hash: 'the-layers' })
    expect(resolveDocLink(from, 'a.md?plain=1#top')).toEqual({ kind: 'file', path: 'docs/specs/a.md', hash: 'top' })
    expect(resolveDocLink(from, 'a%20b.md')).toEqual({ kind: 'file', path: 'docs/specs/a b.md', hash: undefined })
  })

  it('reads a bare fragment as a heading in the doc itself', () => {
    expect(resolveDocLink(from, '#the-specs')).toEqual({ kind: 'anchor', id: 'the-specs' })
  })

  it('leaves anything that leaves the worktree alone', () => {
    for (const href of ['https://example.com/a.md', 'mailto:a@b.c', '//example.com/a.md', '', undefined, '#', '../../../etc/passwd']) {
      expect(resolveDocLink(from, href), String(href)).toBeNull()
    }
  })
})

describe('heading slugs', () => {
  it('matches the fragments docs are written against', () => {
    expect(slugify('The specs')).toBe('the-specs')
    expect(slugify('S06: LLM generator adapter!')).toBe('s06-llm-generator-adapter')
    expect(slugify('  Gate API — list, edit  ')).toBe('gate-api-list-edit')
  })
})
