import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, MessageSquareQuote } from 'lucide-react'

import { containsAcross, selectionAt } from '@/lib/dom-selection'
import { SelectionTooltip, SelectionTooltipAction, SelectionTooltipLabel, SelectionTooltipSeparator } from '@/components/ui/selection-tooltip'

/** Selected text, the range it spans, and where it sits on screen, in viewport coordinates. */
interface Selected {
  text: string
  range: Range
  rect: DOMRect
}

const GAP = 8
const EDGE = 8
/** Stands in for the pill's width until it has been on screen once and measured. */
const ASSUMED_WIDTH = 220
/** Keeps the arrow clear of the pill's rounded corners. */
const ARROW_INSET = 14

/**
 * The live text selection, but only while it lies inside `host`. Reading happens when the
 * user lets go — a pointerup or keyup — so the popover does not chase a drag in progress;
 * `selectionchange` only ever clears, which is what collapsing the selection should do.
 */
function useSelectionIn(host: React.RefObject<HTMLElement | null>): { selected: Selected | null; release: () => void } {
  const [selected, setSelected] = useState<Selected | null>(null)
  // The live Range, so scrolling can re-measure the same selection instead of re-reading it.
  const range = useRef<Range | null>(null)
  // The Selection it came from — a shadow root's own, inside the diff — so letting go of it works there too.
  const source = useRef<Selection | null>(null)

  const clear = useCallback((): void => {
    range.current = null
    setSelected(null)
  }, [])
  const release = useCallback((): void => {
    source.current?.removeAllRanges()
    clear()
  }, [clear])

  useEffect(() => {
    const inHost = (node: Node | null): boolean => node !== null && host.current !== null && containsAcross(host.current, node)

    const read = (event: Event): void => {
      // Events from the popover itself are the user acting on the selection, not changing it.
      const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement ?? null
      if (target?.closest('[data-slot="selection-actions"]')) return
      const selection = selectionAt(event)
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return clear()
      const text = selection.toString().trim()
      const live = selection.getRangeAt(0)
      if (!text || !inHost(live.commonAncestorContainer)) return clear()
      range.current = live.cloneRange()
      source.current = selection
      setSelected({ text, range: range.current, rect: live.getBoundingClientRect() })
    }

    const dropIfCollapsed = (): void => {
      const selection = source.current
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) clear()
    }

    // Scrolling moves the selection under a stationary popover, so re-measure rather than re-read.
    const follow = (): void => {
      const live = range.current
      if (!live) return
      const rect = live.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return clear()
      setSelected((current) => (current ? { ...current, rect } : current))
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clear()
      else read(event)
    }

    document.addEventListener('pointerup', read)
    document.addEventListener('keyup', onKey)
    document.addEventListener('selectionchange', dropIfCollapsed)
    document.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('pointerup', read)
      document.removeEventListener('keyup', onKey)
      document.removeEventListener('selectionchange', dropIfCollapsed)
      document.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [clear, host])

  return { selected, release }
}

/**
 * What you can do with text you highlighted — in the transcript, or in a PR's diff: put it on the
 * clipboard, or hand it to an agent's composer as context for the next turn. Floats just above the selection —
 * below it near the top of the window — and stays out of the way until there is one.
 */
export function SelectionActions({ host, onAsk, askLabel = 'Ask agent' }: {
  host: React.RefObject<HTMLElement | null>
  /** Stages the selected text as context on the composer; the range says where it was taken from. */
  onAsk?: (text: string, range: Range) => void
  /** Names the agent the text goes to. */
  askLabel?: string
}): React.JSX.Element | null {
  const { selected, release } = useSelectionIn(host)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => setCopied(false), [selected?.text])

  // The pill's own width, so clamping it to the window and aiming its arrow both work off the real
  // thing. Re-measured per selection, not per render: "Copied" is wider than "Copy", and re-measuring
  // that would slide the pill out from under the cursor that just clicked it.
  const pill = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const measured = pill.current?.getBoundingClientRect().width ?? 0
    if (measured > 0) setWidth(measured)
  }, [selected?.text])

  if (!selected) return null

  const { rect } = selected
  const above = rect.top > 56
  const span = width || ASSUMED_WIDTH
  const middle = rect.left + rect.width / 2
  // Positioned by its left edge rather than centred: growing to "Copied" then extends the pill
  // rightwards instead of shifting the whole thing, so the arrow stays on the text it points at.
  const left = Math.max(EDGE, Math.min(middle - span / 2, window.innerWidth - EDGE - span))
  // Nudged back onto the selection when the window edge pushed the pill off centre.
  const arrow = Math.min(Math.max(middle - left, ARROW_INSET), span - ARROW_INSET)

  const copy = (): void => {
    // Clipboard access is absent in insecure contexts and writes can be denied.
    navigator.clipboard
      ?.writeText(selected.text)
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {})
  }

  return createPortal(
    <SelectionTooltip
      ref={pill}
      data-slot="selection-actions"
      side={above ? 'top' : 'bottom'}
      aria-label="Selected text"
      // Taking the pointer here would collapse the selection the actions work on.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-50 [&_[data-slot=selection-tooltip-arrow]]:left-[var(--arrow-x)]"
      style={
        {
          left,
          top: above ? rect.top - GAP : rect.bottom + GAP,
          transform: above ? 'translateY(-100%)' : undefined,
          '--arrow-x': `${arrow}px`
        } as React.CSSProperties
      }
    >
      <SelectionTooltipAction aria-label={copied ? 'Copied' : 'Copy the selected text'} tooltip="Copy the selected text" onClick={copy}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <SelectionTooltipLabel>{copied ? 'Copied' : 'Copy'}</SelectionTooltipLabel>
      </SelectionTooltipAction>
      {onAsk ? (
        <>
          <SelectionTooltipSeparator />
          <SelectionTooltipAction
            aria-label={`${askLabel} about the selected text`}
            tooltip="Stage this text as context for your next message"
            onClick={() => {
              onAsk(selected.text, selected.range)
              release()
            }}
          >
            <MessageSquareQuote aria-hidden="true" />
            <SelectionTooltipLabel>{askLabel}</SelectionTooltipLabel>
          </SelectionTooltipAction>
        </>
      ) : null}
    </SelectionTooltip>,
    document.body
  )
}
