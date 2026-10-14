import { useEffect, useState } from 'react'

import { HIGHLIGHT_SWATCHES, type HighlightSwatch } from '@/components/ui/highlight-picker'

import { rangeAt, textOffsets } from './dom-selection'
import { erase, locate, paint, touches, type Span, type Stroke } from './highlights'
import { readStored, writeStored } from './local-store'

/**
 * Strokes are drawn with the CSS Custom Highlight API: ranges registered by name and styled by
 * `::highlight(name)`, so nothing is ever written into the DOM React owns. One registry entry per
 * pen colour is shared by every painter, each adding and removing only its own ranges.
 */
const INK = 'canopy-highlight-'
const supported = typeof CSS !== 'undefined' && 'highlights' in CSS

let inked = false
/** The `::highlight` rules for every pen, made from the palette once, on first use. */
function inkStyles(): void {
  if (inked) return
  inked = true
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(HIGHLIGHT_SWATCHES.map((pen) => `::highlight(${INK}${pen.id}) { background-color: color-mix(in oklab, ${pen.color} 45%, transparent); }`).join('\n'))
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}

function inkFor(color: string): Highlight {
  const existing = CSS.highlights.get(INK + color)
  if (existing) return existing
  const ink = new Highlight()
  CSS.highlights.set(INK + color, ink)
  return ink
}

/**
 * Draws `strokes` over `host`, finding each passage again whenever the host's content changes —
 * a board redrawn, a tab switched — and dropping what is not on screen.
 */
function usePaint(host: React.RefObject<HTMLElement | null>, strokes: readonly Stroke[]): void {
  useEffect(() => {
    const element = host.current
    if (!element || !supported || strokes.length === 0) return
    inkStyles()
    let drawn: [Highlight, Range][] = []
    const wipe = (): void => {
      for (const [ink, range] of drawn) ink.delete(range)
      drawn = []
    }
    const draw = (): void => {
      wipe()
      const text = element.textContent ?? ''
      for (const stroke of strokes) {
        const span = locate(text, stroke.anchor)
        const range = span && rangeAt(element, span)
        if (!range) continue
        const ink = inkFor(stroke.color)
        ink.add(range)
        drawn.push([ink, range])
      }
    }
    draw()
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    })
    observer.observe(element, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      wipe()
    }
  }, [host, strokes])
}

const strokesAt = (key: string | undefined): Stroke[] => (key && readStored<Stroke[]>(key)) || []

/**
 * What a reader highlighted in `host`, remembered in this browser under `scope`, with the
 * strokes drawn over the text. Each change takes the live selection's range. Without a scope
 * there is nothing to remember, and nothing is drawn.
 */
export function useHighlights(host: React.RefObject<HTMLElement | null>, scope: string | undefined) {
  const key = scope && `canopy-highlights:${scope}`
  const [strokes, setStrokes] = useState<Stroke[]>(() => strokesAt(key))
  useEffect(() => setStrokes(strokesAt(key)), [key])
  usePaint(host, strokes)

  /** Runs `change` over the host's text and where `range` sits in it. */
  const at = <T>(range: Range, change: (text: string, span: Span) => T): T | undefined => {
    const element = host.current
    const span = element && textOffsets(element, range)
    return element && span ? change(element.textContent ?? '', span) : undefined
  }
  const save = (next: Stroke[] | undefined): void => {
    if (!next || !key) return
    setStrokes(next)
    writeStored(key, next)
  }
  return {
    touches: (range: Range): boolean => at(range, (text, span) => touches(strokes, text, span)) ?? false,
    paint: (range: Range, color: string): void => save(at(range, (text, span) => paint(strokes, text, span, color))),
    erase: (range: Range): void => save(at(range, (text, span) => erase(strokes, text, span)))
  }
}

const PENS = 'canopy-highlight-pens'
const DEFAULT_PENS = ['yellow', 'green', 'pink']

/** The pens on the highlighter's rail, yellow first, and the rest of the palette "+" can add. */
export function usePens(): { pens: HighlightSwatch[]; more: HighlightSwatch[]; add: (pen: HighlightSwatch) => void } {
  const [ids, setIds] = useState<string[]>(() => readStored<string[]>(PENS) ?? DEFAULT_PENS)
  const pens = ids.flatMap((id) => HIGHLIGHT_SWATCHES.filter((pen) => pen.id === id))
  return {
    pens,
    more: HIGHLIGHT_SWATCHES.filter((pen) => !ids.includes(pen.id)),
    add: (pen) => {
      const next = [...ids, pen.id]
      setIds(next)
      writeStored(PENS, next)
    }
  }
}
