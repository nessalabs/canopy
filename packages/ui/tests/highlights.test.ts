// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { rangeAt, textOffsets } from '../src/lib/dom-selection'
import { anchorAt, erase, locate, paint, touches, type Span } from '../src/lib/highlights'

const TEXT = 'copy first, then curate index.md; copy first is the rule, then curate the rest'
const spanOf = (word: string, from = 0): Span => {
  const at = TEXT.indexOf(word, from)
  return [at, at + word.length]
}

describe('locate', () => {
  it('finds a passage again by its words', () => {
    const span = spanOf('curate index.md')
    expect(locate(TEXT, anchorAt(TEXT, span))).toEqual(span)
  })

  it('tells repeated words apart by what surrounds them', () => {
    const second = spanOf('copy first', 1)
    expect(locate(TEXT, anchorAt(TEXT, second))).toEqual(second)
  })

  it('still finds the passage when the text around it changed', () => {
    const anchor = anchorAt(TEXT, spanOf('index.md'))
    const edited = `A new opening line. ${TEXT}`
    expect(locate(edited, anchor)).toEqual([edited.indexOf('index.md'), edited.indexOf('index.md') + 8])
  })

  it('finds nothing when the passage is not on screen', () => {
    expect(locate('another board entirely', anchorAt(TEXT, spanOf('index.md')))).toBeUndefined()
    expect(locate(TEXT, { quote: '', prefix: '', suffix: '' })).toBeUndefined()
  })
})

describe('paint and erase', () => {
  it('replaces what a new stroke overlaps rather than layering colours', () => {
    const once = paint([], TEXT, spanOf('curate index.md'), 'yellow')
    const twice = paint(once, TEXT, spanOf('index.md'), 'pink')
    expect(twice).toEqual([{ color: 'pink', anchor: anchorAt(TEXT, spanOf('index.md')) }])
  })

  it('keeps strokes it does not touch', () => {
    const list = paint(paint([], TEXT, spanOf('copy first'), 'yellow'), TEXT, spanOf('the rest'), 'green')
    expect(list.map((stroke) => stroke.color)).toEqual(['yellow', 'green'])
    expect(touches(list, TEXT, spanOf('rest'))).toBe(true)
    expect(touches(list, TEXT, spanOf('index.md'))).toBe(false)
    expect(erase(list, TEXT, spanOf('rest')).map((stroke) => stroke.color)).toEqual(['yellow'])
  })
})

describe('textOffsets and rangeAt', () => {
  it('turn a range across elements into offsets of the text, and back', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p>Today the <b>agent</b> reads</p><p>every byte.</p>'
    document.body.append(host)
    const text = host.textContent ?? ''
    const span: Span = [text.indexOf('agent'), text.indexOf('every') + 5]
    const range = rangeAt(host, span)!
    expect(range.toString()).toBe('agent readsevery')
    expect(textOffsets(host, range)).toEqual(span)
    expect(rangeAt(host, [0, text.length + 1])).toBeUndefined()
    host.remove()
  })
})
