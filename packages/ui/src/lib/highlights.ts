/**
 * Highlights a reader paints over text. Each is pinned by its own words and the words either
 * side of it rather than by DOM nodes, so it is found again after the page redraws — a tab
 * switched away and back, a reload, a board re-rendered — and simply stays hidden while its
 * passage is not on screen.
 */

/** A passage, by its words and up to `CONTEXT` characters either side. */
export interface TextAnchor {
  quote: string
  prefix: string
  suffix: string
}

/** One highlighter stroke: a pen colour id and the passage it covers. */
export interface Stroke {
  color: string
  anchor: TextAnchor
}

/** Where a passage sits in a text: `[start, end)` character offsets. */
export type Span = readonly [number, number]

const CONTEXT = 32

export const anchorAt = (text: string, [start, end]: Span): TextAnchor => ({
  quote: text.slice(start, end),
  prefix: text.slice(Math.max(0, start - CONTEXT), start),
  suffix: text.slice(end, end + CONTEXT)
})

/** How many characters `a` and `b` share, counted from their starts (`fromEnd` false) or their ends. */
function shared(a: string, b: string, fromEnd: boolean): number {
  const length = Math.min(a.length, b.length)
  let count = 0
  while (count < length && a.at(fromEnd ? -1 - count : count) === b.at(fromEnd ? -1 - count : count)) count++
  return count
}

/** Where the anchored passage sits in `text`: of every place its words appear, the one whose surroundings match best. */
export function locate(text: string, { quote, prefix, suffix }: TextAnchor): Span | undefined {
  if (!quote) return undefined
  let best: number | undefined
  let bestScore = -1
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const end = at + quote.length
    const score = shared(text.slice(Math.max(0, at - prefix.length), at), prefix, true) + shared(text.slice(end, end + suffix.length), suffix, false)
    if (score > bestScore) [best, bestScore] = [at, score]
  }
  return best === undefined ? undefined : [best, best + quote.length]
}

const overlaps = (a: Span, b: Span): boolean => a[0] < b[1] && b[0] < a[1]

/** The highlights in `list` whose passage is in `text` and overlaps `span`. */
const over = (list: readonly Stroke[], text: string, span: Span): Set<Stroke> =>
  new Set(
    list.filter((stroke) => {
      const at = locate(text, stroke.anchor)
      return at !== undefined && overlaps(at, span)
    })
  )

/** Paints `span` in `color`, over whatever it overlapped: a stroke is replaced, never layered. */
export function paint(list: readonly Stroke[], text: string, span: Span, color: string): Stroke[] {
  const covered = over(list, text, span)
  return [...list.filter((stroke) => !covered.has(stroke)), { color, anchor: anchorAt(text, span) }]
}

/** Removes every highlight that overlaps `span`. */
export function erase(list: readonly Stroke[], text: string, span: Span): Stroke[] {
  const covered = over(list, text, span)
  return list.filter((stroke) => !covered.has(stroke))
}

/** Whether anything highlighted overlaps `span`. */
export const touches = (list: readonly Stroke[], text: string, span: Span): boolean => over(list, text, span).size > 0
