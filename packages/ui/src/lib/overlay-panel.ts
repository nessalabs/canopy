import * as React from "react"

/**
 * The mechanics every Nessa overlay panel needs and none of them should own
 * privately: reading motion out of the theme rather than out of a duplicated
 * constant, returning focus to whatever opened the panel, and following a
 * pointer that has left the small target it pressed.
 *
 * The panels themselves stay separate, because their frames are what makes
 * them different components — Sheet rises over its nearest positioned
 * ancestor and inerts only its siblings, Drawer is portalled, viewport-fixed
 * and modal to the whole document. Everything below is the part underneath
 * that split, and is shared verbatim.
 */

/**
 * A CSS time in milliseconds, or null for a value that is not one. `s` is the
 * unit a bare number is *not*: CSS requires the unit, so anything unparsed is
 * rejected rather than read as seconds.
 */
function parseCssDuration(value: string) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return null
  return value.trim().endsWith("ms") ? parsed : parsed * 1000
}

/** A CSS time in milliseconds, falling back for a value that is not one. */
export function cssDurationInMilliseconds(value: string, fallback: number) {
  return parseCssDuration(value) ?? fallback
}

export interface PanelMotion {
  /** The token's duration in milliseconds. `0` under reduced motion. */
  duration: number
  /** The token's easing, as a CSS timing function. */
  easing: string
}

/**
 * Reads one duration token and one easing token off an element, for motion a
 * panel drives from script rather than from CSS. The tokens collapse to `0ms`
 * under reduced motion, so a caller that skips a zero-duration animation
 * honours the preference without querying it separately.
 */
export function panelMotion(
  node: HTMLElement,
  durationToken: string,
  fallback: number,
  easingToken = "--nessa-motion-easing-standard",
): PanelMotion {
  const styles = getComputedStyle(node)
  return {
    duration: cssDurationInMilliseconds(
      styles.getPropertyValue(durationToken),
      fallback,
    ),
    easing: styles.getPropertyValue(easingToken).trim() || "ease-out",
  }
}

/**
 * How long the element's transition of one property runs, in milliseconds, so
 * a panel that must outlive its own exit is timed from its own CSS rather
 * than from a duplicated constant. The motion-duration tokens collapse to 0ms
 * under reduced motion, which a caller reads back as an immediate unmount.
 */
export function longestTransitionMs(node: HTMLElement, property: string) {
  const style = getComputedStyle(node)
  const list = (value: string) => value.split(",").map((entry) => entry.trim())
  const properties = list(style.transitionProperty)
  const durations = list(style.transitionDuration)
  const delays = list(style.transitionDelay)
  return properties.reduce((longest, candidate, index) => {
    // Only the named property keeps the panel mounted. A host className that
    // replaces the transition property — `transition-none`,
    // `transition-colors` — means there is nothing to wait for, however long
    // the duration says.
    if (candidate !== property && candidate !== "all") return longest
    // CSS repeats the shorter of the property and duration lists rather than
    // padding it, so the index wraps.
    const duration = parseCssDuration(durations[index % durations.length] ?? "") ?? 0
    const delay = parseCssDuration(delays[index % delays.length] ?? "") ?? 0
    return Math.max(longest, duration + delay)
  }, 0)
}

/**
 * The element a panel should hand focus back to when it closes, read at the
 * moment it opens.
 *
 * The body — and the documentElement behind it — is where focus sits when
 * nothing holds it: a programmatic open, a `defaultOpen`, or a browser that
 * does not focus a button on click (Safari, Firefox). It is the resting
 * state, not an opener, so it is reported as no opener at all and the panel's
 * own fallback decides instead.
 */
export function openerFromFocus(ownerDocument: Document | undefined | null) {
  const active = ownerDocument?.activeElement
  if (!(active instanceof HTMLElement)) return null
  if (active === ownerDocument?.body || active === ownerDocument?.documentElement) {
    return null
  }
  return active
}

/**
 * Hands focus back to the opener, or to the host's fallback when the opener
 * cannot take it — a row deleted from inside the panel it opened, a trigger
 * that unmounted while the panel was up.
 *
 * @returns whether focus actually landed on the opener, which a caller inside
 * another library's focus management uses to decide whether to claim the
 * restore or leave it alone.
 */
export function restoreFocusToOpener(
  opener: HTMLElement | null,
  onReturnFocus?: () => void,
) {
  if (!opener?.isConnected) {
    onReturnFocus?.()
    return false
  }
  opener.focus()
  return opener.ownerDocument.activeElement === opener
}

/** A drag in progress, measured along the axis the gesture was opened on. */
export interface DragGesture {
  /** The pointer's position along the axis when the press landed. */
  origin: number
  /** Signed distance from the origin, in CSS pixels. */
  delta: number
}

export interface UseDragGestureOptions {
  /** The axis the gesture is measured along: `x` for `clientX`, `y` for `clientY`. */
  axis: "x" | "y"
  /**
   * Runs on the press, before the gesture opens. Return `false` to refuse it —
   * a handle whose panel has not been measured yet, say — and no drag starts.
   */
  onStart?: (event: React.PointerEvent<HTMLElement>) => boolean | void
  /** Runs on every pointer move while the gesture is open. */
  onMove?: (gesture: DragGesture) => void
  /**
   * Runs when the pointer is released. It is given the last *move*, not the
   * release: `clientY` is 0 on synthetic events and on some touch releases,
   * and reading the end from there looks like a large fling in whichever
   * direction the origin happens to lie.
   */
  onEnd?: (gesture: DragGesture) => void
  /** Runs when the platform cancels the gesture, and on an explicit `cancel()`. */
  onCancel?: () => void
}

/**
 * A pointer drag that survives leaving the element it started on.
 *
 * The gesture is followed on the document, not on the handle: a small target
 * is left behind by the first fast movement, and a pointer capture the
 * platform refuses would otherwise strand a drag that can never be ended.
 * Capture is still requested, as an affordance — it keeps the cursor and the
 * hover state on the handle for the whole drag — but nothing depends on it,
 * so synthetic events in tests drag and settle like real ones.
 *
 * One gesture at a time: a second finger landing on the handle must not drive
 * the drag from the first finger's origin.
 */
export function useDragGesture({
  axis,
  onStart,
  onMove,
  onEnd,
  onCancel,
}: UseDragGestureOptions) {
  const [dragging, setDragging] = React.useState(false)
  const gestureRef = React.useRef<{
    pointerId: number
    origin: number
    delta: number
    handle: HTMLElement
  } | null>(null)

  // The callbacks are reached through a box so the document listeners below
  // attach once per gesture: an inline `onMove` / `onStart` changes identity
  // on every render, and every drag step is a render.
  const handlers = React.useRef({ onStart, onMove, onEnd, onCancel })
  React.useLayoutEffect(() => {
    handlers.current = { onStart, onMove, onEnd, onCancel }
  })

  const release = React.useCallback(() => {
    const gesture = gestureRef.current
    gestureRef.current = null
    setDragging(false)
    if (!gesture) return null
    if (gesture.handle.hasPointerCapture(gesture.pointerId)) {
      gesture.handle.releasePointerCapture(gesture.pointerId)
    }
    return gesture
  }, [])

  /** Ends the gesture without settling it — for a handle whose panel is going away. */
  const cancel = React.useCallback(() => {
    if (!gestureRef.current) return
    release()
    handlers.current.onCancel?.()
  }, [release])

  const start = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || gestureRef.current) return
      if (handlers.current.onStart?.(event) === false) return
      const handle = event.currentTarget
      const origin = axis === "x" ? event.clientX : event.clientY
      gestureRef.current = { pointerId: event.pointerId, origin, delta: 0, handle }
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        // Capture is optional; the document listeners below are not. A
        // synthetic pointer event (a play test) has no active pointer id.
      }
      setDragging(true)
    },
    [axis],
  )

  React.useEffect(() => {
    if (!dragging) return
    const gesture = gestureRef.current
    if (!gesture) return
    const ownerDocument = gesture.handle.ownerDocument
    const move = (event: PointerEvent) => {
      const current = gestureRef.current
      if (!current || current.pointerId !== event.pointerId) return
      const position = axis === "x" ? event.clientX : event.clientY
      current.delta = position - current.origin
      handlers.current.onMove?.({ origin: current.origin, delta: current.delta })
    }
    const end = (event: PointerEvent) => {
      if (gestureRef.current?.pointerId !== event.pointerId) return
      const settled = release()
      if (!settled) return
      handlers.current.onEnd?.({ origin: settled.origin, delta: settled.delta })
    }
    const abort = (event: PointerEvent) => {
      if (gestureRef.current?.pointerId !== event.pointerId) return
      release()
      handlers.current.onCancel?.()
    }
    ownerDocument.addEventListener("pointermove", move)
    ownerDocument.addEventListener("pointerup", end)
    ownerDocument.addEventListener("pointercancel", abort)
    return () => {
      ownerDocument.removeEventListener("pointermove", move)
      ownerDocument.removeEventListener("pointerup", end)
      ownerDocument.removeEventListener("pointercancel", abort)
    }
  }, [axis, dragging, release])

  return { dragging, start, cancel }
}
