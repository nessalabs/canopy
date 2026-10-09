// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { CONTEXT_MIME, readDrop, toStaged } from '../src/lib/agent-context'
import { containsAcross, snippetSource } from '../src/lib/dom-selection'

const transfer = (data: Record<string, string>): Pick<DataTransfer, 'getData'> => ({ getData: (type) => data[type] ?? '' })

describe('toStaged', () => {
  it('names a file by its name and hands the agent its path', () => {
    expect(toStaged({ kind: 'path', path: 'src/a/b.ts', dir: false })).toEqual({ kind: 'file', label: 'b.ts', text: 'src/a/b.ts' })
    expect(toStaged({ kind: 'path', path: 'src/a', dir: true })).toEqual({ kind: 'file', label: 'a/', text: 'src/a/' })
  })

  it('names a snippet after where it came from', () => {
    expect(toStaged({ kind: 'snippet', text: 'x', path: 'a.ts', lines: [3, 7] }).label).toBe('a.ts:3–7')
    expect(toStaged({ kind: 'snippet', text: 'x', path: 'a.ts', lines: [3, 3] }).label).toBe('a.ts:3')
    expect(toStaged({ kind: 'snippet', text: 'a\nb' }).label).toBe('Selected text (2 lines)')
  })
})

describe('readDrop', () => {
  it('prefers Canopy context over the plain text beside it', () => {
    const path = { kind: 'path', path: 'a.ts', dir: false }
    expect(readDrop(transfer({ [CONTEXT_MIME]: JSON.stringify(path), 'text/plain': 'a.ts' }))).toEqual(path)
  })

  it('takes plain text as a snippet, and ignores junk and empty drops', () => {
    expect(readDrop(transfer({ [CONTEXT_MIME]: '{bad', 'text/plain': ' hi ' }))).toEqual({ kind: 'snippet', text: 'hi' })
    expect(readDrop(transfer({ [CONTEXT_MIME]: '{"kind":"path"}' }))).toBeNull()
    expect(readDrop(transfer({}))).toBeNull()
  })
})

describe('snippetSource', () => {
  it('reads the file and line span through the diff’s shadow root', () => {
    document.body.innerHTML = '<div id="pane" data-file-path="src/x.ts"><div id="diff"></div></div>'
    const shadow = document.getElementById('diff')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<div data-line="12"><span>const a</span></div><div data-line="14"><span>const b</span></div>'
    const [first, last] = [...shadow.querySelectorAll('span')].map((span) => span.firstChild!)
    const range = document.createRange()
    range.setStart(first!, 0)
    range.setEnd(last!, 3)
    expect(snippetSource(range)).toEqual({ path: 'src/x.ts', lines: [12, 14] })
    expect(containsAcross(document.getElementById('pane')!, first!)).toBe(true)
    expect(containsAcross(document.createElement('div'), first!)).toBe(false)
  })

  it('leaves out what it cannot tell', () => {
    document.body.innerHTML = '<p>loose prose</p>'
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('p')!)
    expect(snippetSource(range)).toEqual({})
  })
})
