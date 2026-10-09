import { describe, expect, it } from 'vitest'

import { parseFileRef, remarkFileRefs, resolvePath, splitRefs } from '../src/lib/file-refs'

describe('parseFileRef', () => {
  it('reads the ways agents cite lines', () => {
    expect(parseFileRef('src/a.ts:42')).toEqual({ path: 'src/a.ts', lines: { start: 42, end: 42 } })
    expect(parseFileRef('src/a.ts:42-50')).toEqual({ path: 'src/a.ts', lines: { start: 42, end: 50 } })
    expect(parseFileRef('src/a.ts#L42-L50')).toEqual({ path: 'src/a.ts', lines: { start: 42, end: 50 } })
    expect(parseFileRef('./a.tsx')).toEqual({ path: 'a.tsx' })
  })

  it('reads an absolute path inside the checkout relative to it', () => {
    expect(parseFileRef('/w/canopy/src/a.ts:3', '/w/canopy')).toEqual({ path: 'src/a.ts', lines: { start: 3, end: 3 } })
  })

  it('is not fooled by URLs, versions or prose', () => {
    expect(parseFileRef('https://github.com/o/r/blob/a.ts')).toBeNull()
    expect(parseFileRef('1.5:3')).toBeNull()
    expect(parseFileRef('see a.ts:3')).toBeNull()
  })
})

describe('resolvePath', () => {
  const known = ['packages/daemon/src/routes/agents.ts', 'packages/ui/src/agents.ts', 'packages/ui/src/app.tsx']
  it('completes a unique tail and leaves an ambiguous one as written', () => {
    expect(resolvePath('routes/agents.ts', known)).toBe('packages/daemon/src/routes/agents.ts')
    expect(resolvePath('app.tsx', known)).toBe('packages/ui/src/app.tsx')
    expect(resolvePath('agents.ts', known)).toBe('agents.ts')
  })
})

describe('splitRefs', () => {
  it('finds references in prose and keeps the text around them', () => {
    expect(splitRefs('The change is in src/a.ts:12-14, see also b.md#L3.')).toEqual([
      'The change is in ',
      { raw: 'src/a.ts:12-14', ref: { path: 'src/a.ts', lines: { start: 12, end: 14 } } },
      ', see also ',
      { raw: 'b.md#L3', ref: { path: 'b.md', lines: { start: 3, end: 3 } } },
      '.'
    ])
    expect(splitRefs('version 1.2:3 and a.ts alone')).toEqual(['version 1.2:3 and a.ts alone'])
  })
})

describe('remarkFileRefs', () => {
  it('links references in text and in code spans of their own, and nothing inside links or code blocks', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'In a.ts:3 and ' }, { type: 'inlineCode', value: 'b.ts:9' }, { type: 'text', value: ' ' }, { type: 'inlineCode', value: 'c.ts' }] },
        { type: 'link', url: 'x', children: [{ type: 'text', value: 'd.ts:1' }] },
        { type: 'code', value: 'e.ts:2' }
      ]
    }
    remarkFileRefs()(tree)
    const [paragraph, untouchedLink, code] = tree.children
    expect(paragraph!.children!.map((node) => (node.type === 'link' ? `link:${(node as { url: string }).url}` : node.type))).toEqual(['text', 'link:a.ts:3', 'text', 'link:b.ts:9', 'text', 'inlineCode'])
    expect(untouchedLink!.children![0]).toEqual({ type: 'text', value: 'd.ts:1' })
    expect(code).toEqual({ type: 'code', value: 'e.ts:2' })
  })
})
