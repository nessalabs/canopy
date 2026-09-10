import * as React from "react"
import { Maximize2, Minimize2, X } from "lucide-react"

import {
  openerFromFocus,
  panelMotion,
  restoreFocusToOpener,
  useDragGesture,
} from "@/lib/overlay-panel"
import { cn } from "@/lib/utils"

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

/**
 * How much longer the exit runs than the sheet's other motion.
 *
 * A panel leaving is the one movement nobody is driving — there is no pointer
 * under it and no control waiting on it — so it can afford to take its time
 * where an entrance or an expand cannot. Derived from the duration token
 * rather than written as its own value, so reduced motion still collapses it
 * to nothing along with everything else.
 */
const exitDurationScale = 1.6

function cancelAnimations(animations: Animation[]) {
  for (const animation of animations) animation.cancel()
}

/**
 * Holds the inline sizing an interpolation needs while it plays, and clears it
 * once the motion settles.
 *
 * The timer is the authority and `finished` only shortens it. A document that
 * is not being rendered — a background tab, a hidden pane — never advances its
 * timeline, so the animation never finishes and its promise never resolves.
 * Without the timer the panel would keep the inline height and `flex-grow: 0`
 * written for the interpolation, pinned at the size it was moving *from*.
 *
 * @returns the cancel function the caller returns from its effect.
 */
function settleAnimations(
  animations: Animation[],
  duration: number,
  clearInline: () => void,
) {
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    window.clearTimeout(timer)
    clearInline()
    cancelAnimations(animations)
  }
  const timer = window.setTimeout(finish, duration + 50)
  void Promise.all(animations.map((animation) => animation.finished)).then(
    finish,
    () => {},
  )
  return () => {
    settled = true
    window.clearTimeout(timer)
    cancelAnimations(animations)
    clearInline()
  }
}

/**
 * How many open sheets are covering each sibling. Sheets can stack — a
 * details panel over a queue — and whichever closes first must not uncover
 * content the survivor is still drawn over. Elements a host inerted itself
 * never enter the map, and so are never un-inerted by a sheet closing.
 */
const coverCounts = new WeakMap<HTMLElement, number>()

const SheetContext = React.createContext<{
  close: () => void
  expanded: boolean
  setExpanded: (expanded: boolean) => void
  /** Whether a drag is stretching the panel right now. */
  dragging: boolean
  /** Pins the panel at its current height so a drag can stretch it. */
  beginDrag: () => boolean
  /** Stretches the panel to follow the drag, in pixels from the press. */
  dragBy: (delta: number) => void
  /**
   * Releases the drag. `settling` says a state change is coming, whose own
   * interpolation carries the panel the rest of the way; `"dismiss"` hands
   * the dragged offset to `close` as a translate so the exit slide continues
   * the gesture instead of snapping back to the natural height; without either
   * the panel returns to its natural height under this call.
   */
  endDrag: (settling: boolean | "dismiss") => void
}>({
  close: () => {},
  expanded: false,
  setExpanded: () => {},
  dragging: false,
  beginDrag: () => false,
  dragBy: () => {},
  endDrag: () => {},
})

/**
 * Reads the enclosing sheet: dismiss, whether the panel fills its ancestor,
 * and the expand toggle. SheetExpand, SheetClose, and SheetAction use it.
 */
function useSheet() {
  return React.useContext(SheetContext)
}

export interface SheetProps extends React.ComponentProps<"div"> {
  /** Dismisses the sheet; the backdrop, Escape, and SheetClose all call it. */
  onClose: () => void
  /** The accessible name of the dialog. */
  label?: string
  /**
   * Puts focus back where it belongs on close, when the control that opened
   * the sheet is gone by then. The sheet returns focus to its opener whenever
   * that element is still in the document, and calls this instead when it is
   * not — including when nothing held focus at open time, a programmatic
   * open where there was never an opener to return to.
   */
  onReturnFocus?: () => void
  /**
   * Controlled expand: `true` fills the positioned ancestor, `false` is the
   * bottom drawer. Pair with `onExpandedChange`.
   */
  expanded?: boolean
  /** Uncontrolled initial expand. Drawer by default. */
  defaultExpanded?: boolean
  /** Fires when SheetExpand toggles the panel between drawer and filled. */
  onExpandedChange?: (expanded: boolean) => void
  /**
   * When true (the default), the sheet is modal to its positioned ancestor:
   * `aria-modal`, Tab stays inside the panel, and siblings go inert. Queue
   * and details use this. When false, Tab is not trapped and `aria-modal` is
   * omitted so chrome outside the ancestor — a tab strip and composer around
   * a transcript-scoped sheet — stays reachable. Annotations use this.
   */
  modal?: boolean
}

/**
 * A bottom sheet that rises over its nearest positioned ancestor — typically
 * a chat window — without leaving that frame. By default it is a modal
 * dialog: the backdrop and Escape dismiss it, Tab stays inside, focus moves
 * into the panel on open and returns to the opener on close, and the
 * siblings it covers go inert so nothing behind it takes a pointer or a
 * keystroke. Pass `modal={false}` for a contained extra-details surface that
 * still covers its siblings but leaves surrounding chrome in the tab order.
 *
 * Mount it as a child of the ancestor it should fill. Queue, agent details,
 * and activity (thought / explored) sit on the chat frame so Expand covers
 * the window; annotations sit in the tabpanel so the tab strip and composer
 * stay. Prefer one modal sheet per ancestor — two stacked modal sheets
 * both trap Tab.
 *
 * Compose the panel from SheetHandle, SheetHeader, SheetTitle, SheetClose,
 * SheetExpand, SheetAction, and SheetBody. SheetExpand toggles the drawer
 * into a filled extra-details surface over the same ancestor — the host
 * that positions the transcript (rather than the whole window) keeps its
 * tab strip and composer when the panel expands. Dragging the grab bar
 * does the same: up expands, down minimizes or dismisses, and the panel
 * stretches under the pointer while the drag lasts. The drawer lifts
 * a short way from the bottom on open; expand and minimize interpolate
 * height so the panel grows and recedes in place. Both use the slow
 * duration and standard easing so the motion stays one language. Dismissal
 * slides the panel back out before the host is told to unmount it, so the
 * sheet leaves the way it arrived. Reduced motion skips them. The sheet draws the chrome and owns dismissal; the
 * host owns what the panel shows.
 */
function Sheet({
  onClose,
  label = "Sheet",
  onReturnFocus,
  expanded: expandedProp,
  defaultExpanded = false,
  onExpandedChange,
  modal = true,
  className,
  children,
  onKeyDown,
  ...props
}: SheetProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const backdropRef = React.useRef<HTMLDivElement>(null)
  const onCloseRef = React.useRef(onClose)
  const onReturnFocusRef = React.useRef(onReturnFocus)
  const onExpandedChangeRef = React.useRef(onExpandedChange)
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    React.useState(defaultExpanded)
  const isExpandedControlled = expandedProp !== undefined
  const expanded = isExpandedControlled ? expandedProp : uncontrolledExpanded
  React.useEffect(() => {
    onCloseRef.current = onClose
    onReturnFocusRef.current = onReturnFocus
    onExpandedChangeRef.current = onExpandedChange
  })
  const openerRef = React.useRef<HTMLElement | null>(null)
  // Un-inerts the siblings this sheet covered. Held in a ref so a dismissal
  // can run it itself: React removes the panel's node on the commit that
  // unmounts it but flushes this effect's cleanup in a later task, which
  // would leave the siblings inert and unfocusable after the sheet is gone.
  const releaseCoverRef = React.useRef<() => void>(() => {})
  const restoredRef = React.useRef(false)
  const [closing, setClosing] = React.useState(false)
  const closingRef = React.useRef(false)
  const closeTimerRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  /** Cancels an in-flight height settle (expand, collapse, or drag snap-back). */
  const cancelSettleRef = React.useRef<(() => void) | null>(null)

  const cancelSettle = React.useCallback(() => {
    cancelSettleRef.current?.()
    cancelSettleRef.current = null
  }, [])

  /**
   * Dismisses the sheet, letting the panel slide out first.
   *
   * The host owns whether the sheet is mounted, so `onClose` is what removes
   * it — and calling that straight away would cut the exit before it drew a
   * frame. The panel is animated down first and the host is told once it has
   * left, which is why every dismissal (the backdrop, Escape, SheetClose,
   * SheetAction, a drag past the threshold) goes through here.
   */
  const close = React.useCallback(() => {
    if (closingRef.current) return
    // Arm the guard before any leave path — reduced motion and missing
    // animate() still call leave() immediately and must not re-enter.
    closingRef.current = true
    setClosing(true)
    cancelSettle()
    const panel = panelRef.current
    const backdrop = backdropRef.current
    // Focus returns in leave() once the exit has settled (or immediately under
    // reduced motion). Restoring earlier would fight a still-mounted dialog.
    const leave = () => {
      // Host unmount from an earlier leave (or a race with Escape+Done) must
      // not fire onClose again — the exit promise and timer both call finish.
      if (!mountedRef.current) return
      // The panel is still up for the length of the slide, so the siblings it
      // covers are still inert and the focused control is still inside it.
      // Both are undone here rather than in the unmount cleanup: an inert
      // opener cannot take focus, and the cleanup runs a task too late.
      releaseCoverRef.current()
      restoredRef.current = true
      restoreFocusToOpener(openerRef.current, onReturnFocusRef.current)
      onCloseRef.current()
    }
    if (!panel || typeof panel.animate !== "function") return leave()
    if (window.matchMedia(reducedMotionQuery).matches) return leave()
    // Emphasized easing, like the drawer's slide: the standard curve is a
    // decelerate, which covers most of the distance in the first moments and
    // reads as the panel being dropped rather than let go.
    const { duration, easing } = panelMotion(
      panel,
      "--nessa-motion-duration-slow",
      300,
      "--nessa-motion-easing-emphasized",
    )
    if (duration === 0) return leave()
    const exitDuration = duration * exitDurationScale
    // A drag-to-dismiss may already have translated the panel partway down —
    // start from that offset so the exit continues the gesture instead of
    // jumping the panel back to its resting place first.
    const computedTranslate = getComputedStyle(panel).translate
    const fromTranslate =
      panel.style.translate ||
      (computedTranslate && computedTranslate !== "none" ? computedTranslate : "0 0")
    const animations = [
      panel.animate(
        [
          { translate: fromTranslate, opacity: 1 },
          { translate: "0 100%", opacity: 0 },
        ],
        { duration: exitDuration, easing, fill: "forwards" },
      ),
    ]
    if (backdrop) {
      animations.push(
        backdrop.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: exitDuration,
          easing,
          fill: "forwards",
        }),
      )
    }
    let left = false
    const finish = () => {
      if (left) return
      left = true
      window.clearTimeout(closeTimerRef.current)
      leave()
    }
    // The same timer authority the entrance and the expand use: a document
    // that is not being rendered never settles the animation, and a sheet
    // that cannot finish leaving would never be removed at all. The
    // animations are deliberately left uncancelled — the panel unmounts
    // next, and reverting them first would flash it back into place.
    closeTimerRef.current = window.setTimeout(finish, exitDuration + 50)
    void Promise.all(animations.map((animation) => animation.finished)).then(
      finish,
      () => {},
    )
  }, [cancelSettle])

  React.useEffect(() => {
    // StrictMode remounts run cleanup then setup again — re-arm so leave()
    // still fires onClose after the simulated unmount.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      window.clearTimeout(closeTimerRef.current)
      cancelSettle()
    }
  }, [cancelSettle])
  const setExpanded = React.useCallback((next: boolean) => {
    if (!isExpandedControlled) setUncontrolledExpanded(next)
    onExpandedChangeRef.current?.(next)
  }, [isExpandedControlled])
  const dragStartHeightRef = React.useRef(0)
  const dragFrameHeightRef = React.useRef(0)
  const [dragging, setDragging] = React.useState(false)

  const clearDragInline = React.useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    panel.style.height = ""
    panel.style.maxHeight = ""
    panel.style.flexBasis = ""
    panel.style.flexGrow = ""
    panel.style.flexShrink = ""
    panel.style.overflow = ""
  }, [])

  const beginDrag = React.useCallback(() => {
    const panel = panelRef.current
    const frame = ref.current
    if (!panel) return false
    // A settle still playing from the last expand/collapse/snap-back would
    // fight the new drag's height writes — cancel it before locking size.
    cancelSettle()
    const height = panel.getBoundingClientRect().height
    dragStartHeightRef.current = height
    dragFrameHeightRef.current = frame?.getBoundingClientRect().height ?? height
    panel.style.height = `${height}px`
    // The collapsed panel is capped at a fraction of the frame, and the
    // curtain has to be free to reach the top of it.
    panel.style.maxHeight = "none"
    // See the interpolation below: an expanded panel resolves its height from
    // `flex-basis`, so a drag that starts from expanded needs this too.
    panel.style.flexBasis = "auto"
    panel.style.flexGrow = "0"
    panel.style.flexShrink = "0"
    panel.style.overflow = "hidden"
    // The body takes its filled layout for the whole drag, not just once the
    // panel lands expanded. A body that stays sized for the collapsed panel
    // leaves the growing surface half empty under the pointer, and the
    // content only arrives on release — the drag stops reading as the same
    // component being stretched.
    setDragging(true)
    return true
  }, [cancelSettle])
  const dragBy = React.useCallback((delta: number) => {
    const panel = panelRef.current
    if (!panel) return
    // Up is negative, and up grows the panel: the bottom edge stays pinned to
    // the frame while the top edge follows the pointer. Frame height was
    // cached in beginDrag so every move does not remeasure.
    const height = Math.min(
      Math.max(dragStartHeightRef.current - delta, 0),
      dragFrameHeightRef.current,
    )
    panel.style.height = `${height}px`
    // The settle interpolates from wherever the pointer left the panel, so the
    // height it will move *from* is kept in step with the drag.
    prevHeightRef.current = height
  }, [])

  const endDrag = React.useCallback(
    (settling: boolean | "dismiss") => {
      const panel = panelRef.current
      setDragging(false)
      if (!panel) return
      if (settling === "dismiss") {
        // The drag shrank height with the bottom edge pinned. Clearing that
        // height would snap the top edge back up before close() can slide —
        // the hitch the Done button never shows. Convert the shrink into a
        // translate so the exit animation continues from where the finger left.
        const alreadyDown = Math.max(
          0,
          dragStartHeightRef.current - panel.getBoundingClientRect().height,
        )
        clearDragInline()
        panel.style.translate = alreadyDown > 0 ? `0 ${alreadyDown}px` : ""
        return
      }
      const from = panel.getBoundingClientRect().height
      clearDragInline()
      prevHeightRef.current = from
      // A state change is coming: its own interpolation starts from `from`.
      if (settling) return
      const to = panel.getBoundingClientRect().height
      if (Math.abs(from - to) < 0.5) return
      if (typeof panel.animate !== "function") return
      if (window.matchMedia(reducedMotionQuery).matches) return
      const { duration, easing } = panelMotion(
        panel,
        "--nessa-motion-duration-slow",
        300,
      )
      if (duration === 0) return
      panel.style.height = `${from}px`
      panel.style.flexBasis = "auto"
      panel.style.flexGrow = "0"
      panel.style.flexShrink = "0"
      panel.style.overflow = "hidden"
      const animations = [
        panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
          duration,
          easing,
          fill: "forwards",
        }),
      ]
      cancelSettle()
      cancelSettleRef.current = settleAnimations(animations, duration, clearDragInline)
    },
    [cancelSettle, clearDragInline],
  )

  const context = React.useMemo(
    () => ({
      close,
      expanded,
      setExpanded,
      dragging,
      beginDrag,
      dragBy,
      endDrag,
    }),
    [beginDrag, close, dragBy, dragging, endDrag, expanded, setExpanded],
  )
  const openedExpanded = React.useRef(expanded)
  const enterAnimationsRef = React.useRef<Animation[]>([])
  const prevExpandedRef = React.useRef(expanded)
  const prevHeightRef = React.useRef<number | null>(null)
  const collapsedRadiusRef = React.useRef("0px")

  React.useEffect(() => {
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel || typeof panel.animate !== "function") return
    if (window.matchMedia(reducedMotionQuery).matches) return
    const { duration, easing } = panelMotion(
      panel,
      "--nessa-motion-duration-slow",
      300,
    )
    if (duration === 0) return
    const animations: Animation[] = []
    if (openedExpanded.current) {
      animations.push(
        panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing }),
      )
    } else {
      // A short lift — a fraction of the panel, not a full-height slide —
      // plus a fade, so the drawer arrives from below without rushing.
      animations.push(
        panel.animate(
          [
            { opacity: 0, translate: "0 8%" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration, easing },
        ),
      )
      if (backdrop) {
        animations.push(
          backdrop.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration,
            easing,
          }),
        )
      }
    }
    enterAnimationsRef.current = animations
    // Same timer authority as the expand interpolation. These keyframes carry
    // no fill, so an animation frozen at time 0 by a document that is not
    // being rendered holds its *first* keyframe: a sheet opened in a
    // background tab would sit transparent and offset until the tab is shown.
    const settle = settleAnimations(animations, duration, () => {})
    return () => {
      settle()
      enterAnimationsRef.current = []
    }
  }, [])

  React.useLayoutEffect(() => {
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel) return
    if (!expanded) {
      collapsedRadiusRef.current = getComputedStyle(panel).borderTopLeftRadius
    }
    const nextHeight = panel.getBoundingClientRect().height
    const prevHeight = prevHeightRef.current
    prevHeightRef.current = nextHeight
    const wasExpanded = prevExpandedRef.current
    prevExpandedRef.current = expanded
    if (wasExpanded === expanded) return
    cancelAnimations(enterAnimationsRef.current)
    enterAnimationsRef.current = []
    if (window.matchMedia(reducedMotionQuery).matches) return
    if (
      prevHeight == null ||
      typeof panel.animate !== "function" ||
      Math.abs(prevHeight - nextHeight) < 0.5
    ) {
      return
    }
    const { duration, easing } = panelMotion(
      panel,
      "--nessa-motion-duration-slow",
      300,
    )
    if (duration === 0) return
    const collapsedRadius = `${collapsedRadiusRef.current} ${collapsedRadiusRef.current} 0 0`
    const fromRadius = wasExpanded ? "0px" : collapsedRadius
    const toRadius = expanded ? "0px" : collapsedRadius
    panel.style.height = `${prevHeight}px`
    // `flex-basis` and not just the grow/shrink pair: the expanded panel is
    // `flex-1`, whose `flex-basis: 0%` is the main size a column flex item
    // actually resolves to — an animated `height` under it changes nothing,
    // and the panel would sit at zero for the whole interpolation and then
    // snap to its full size when these overrides came off.
    panel.style.flexBasis = "auto"
    panel.style.flexGrow = "0"
    panel.style.flexShrink = "0"
    panel.style.overflow = "hidden"
    const animations: Animation[] = [
      panel.animate(
        [
          { height: `${prevHeight}px`, borderRadius: fromRadius },
          { height: `${nextHeight}px`, borderRadius: toRadius },
        ],
        { duration, easing, fill: "forwards" },
      ),
    ]
    if (backdrop) {
      const fromOpacity = wasExpanded ? 0 : 1
      const toOpacity = expanded ? 0 : 1
      backdrop.style.opacity = String(fromOpacity)
      animations.push(
        backdrop.animate([{ opacity: fromOpacity }, { opacity: toOpacity }], {
          duration,
          easing,
          fill: "forwards",
        }),
      )
    }
    const clearInline = () => {
      panel.style.height = ""
      panel.style.flexBasis = ""
      panel.style.flexGrow = ""
      panel.style.flexShrink = ""
      panel.style.overflow = ""
      if (backdrop) backdrop.style.opacity = ""
    }
    cancelSettle()
    const cancel = settleAnimations(animations, duration, clearInline)
    cancelSettleRef.current = cancel
    return () => {
      if (cancelSettleRef.current === cancel) cancelSettleRef.current = null
      cancel()
    }
  }, [cancelSettle, expanded])

  React.useEffect(() => {
    const node = ref.current
    const ownerDocument = node?.ownerDocument
    if (!node || !ownerDocument) return
    const opener = openerFromFocus(ownerDocument)
    openerRef.current = opener
    const firstControl = node.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    ;(firstControl ?? node).focus()

    const parent = node.parentElement
    const covered = new Set<HTMLElement>()
    const release = (sibling: HTMLElement) => {
      covered.delete(sibling)
      const count = (coverCounts.get(sibling) ?? 1) - 1
      if (count > 0) return coverCounts.set(sibling, count)
      coverCounts.delete(sibling)
      sibling.removeAttribute("inert")
    }
    const coverSiblings = () => {
      for (const sibling of covered) if (!sibling.isConnected) release(sibling)
      for (const sibling of parent?.children ?? []) {
        if (sibling === node || !(sibling instanceof HTMLElement)) continue
        if (sibling.getAttribute("role") === "dialog") continue
        if (covered.has(sibling)) continue
        const count = coverCounts.get(sibling)
        if (count === undefined && sibling.hasAttribute("inert")) continue
        coverCounts.set(sibling, (count ?? 0) + 1)
        sibling.setAttribute("inert", "")
        covered.add(sibling)
      }
    }
    coverSiblings()
    const observer = parent ? new MutationObserver(coverSiblings) : null
    if (parent && observer) observer.observe(parent, { childList: true })
    releaseCoverRef.current = () => {
      // The observer goes first. It is still live between a dismissal and the
      // unmount cleanup a task later, and the sheet's own removal is a
      // childList change — which would re-cover the siblings this just
      // released, leaving them inert with no sheet left to release them.
      observer?.disconnect()
      for (const sibling of [...covered]) release(sibling)
    }
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"))
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const order = focusables()
      if (order.length === 0) return
      const first = order[0]!
      const last = order[order.length - 1]!
      const current = ownerDocument.activeElement
      if (event.shiftKey && (current === first || !node.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }
    if (modal) {
      ownerDocument.addEventListener("keydown", handleTab, { capture: true })
    }
    return () => {
      observer?.disconnect()
      if (modal) {
        ownerDocument.removeEventListener("keydown", handleTab, {
          capture: true,
        })
      }
      releaseCoverRef.current()
      // A dismissal that played the exit has already put focus home; running
      // it again here would fire the host's fallback for an opener this
      // instance no longer owns.
      if (!restoredRef.current) {
        restoreFocusToOpener(openerRef.current, onReturnFocusRef.current)
      }
      openerRef.current = null
    }
    // Mount-once by design; modal is the value at open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.key !== "Escape" || event.defaultPrevented) return
    event.preventDefault()
    // Same path as Done / backdrop / drag-dismiss: play the exit, then tell
    // the host. Calling onClose here would unmount mid-animation and race a
    // second leave if Done was already closing.
    close()
  }

  return (
    <SheetContext.Provider value={context}>
      <div
        ref={ref}
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={label}
        data-slot="sheet"
        data-expanded={expanded ? "true" : "false"}
        data-closing={closing ? "true" : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={cn(
          "absolute inset-0 z-30 flex flex-col justify-end overflow-hidden rounded-[inherit] font-sans",
          // A sheet on its way out takes no more presses: the panel is still
          // there for the length of the slide, and a second click on Done
          // must not queue another dismissal behind it.
          closing && "pointer-events-none",
          className,
        )}
        {...props}
      >
        <div
          ref={backdropRef}
          aria-hidden="true"
          data-slot="sheet-backdrop"
          onClick={close}
          className={cn(
            "absolute inset-0 bg-foreground/40",
            expanded && "pointer-events-none opacity-0",
          )}
        />
        <div
          ref={panelRef}
          data-slot="sheet-panel"
          data-expanded={expanded ? "true" : "false"}
          className={cn(
            "relative z-10 flex w-full flex-col bg-card text-card-foreground shadow-[0_-8px_32px] shadow-(color:--foreground)/20",
            expanded
              ? "min-h-0 flex-1 overflow-hidden rounded-none"
              : "max-h-[85%] overflow-hidden rounded-t-3xl",
          )}
        >
          {children}
        </div>
      </div>
    </SheetContext.Provider>
  )
}

const sheetDragThreshold = 48

/**
 * The grab bar that marks the panel as a drawer. Dragging stretches the panel
 * in place — the bottom edge stays pinned to the frame while the top edge
 * follows the pointer, so the surface grows and recedes like a curtain rather
 * than lifting away from the frame. Releasing past the threshold settles into
 * expanded, minimized, or dismissed; releasing short of it returns the panel
 * to the height it started from.
 *
 * Positioned absolutely over the panel's top band (under SheetHeader) rather
 * than claiming its own row, so header controls can sit close to the edge
 * while the drag target stays tall enough to grab. Hosts that omit SheetHeader
 * should pad the first content row (`pt-11`) so this overlay does not eat its
 * presses.
 */
function SheetHandle({ className, ...props }: React.ComponentProps<"div">) {
  const { expanded, setExpanded, close, beginDrag, dragBy, endDrag } =
    useSheet()

  const { start } = useDragGesture({
    axis: "y",
    onStart: () => beginDrag(),
    onMove: ({ delta }) => dragBy(delta),
    onEnd: ({ delta }) => {
      const grow = delta <= -sheetDragThreshold
      const shrink = delta >= sheetDragThreshold
      if (grow) {
        endDrag(!expanded)
        setExpanded(true)
      } else if (shrink) {
        if (expanded) {
          endDrag(true)
          setExpanded(false)
        } else {
          // Continue into the same slide-down Done uses — do not snap height
          // back first.
          endDrag("dismiss")
          close()
        }
      } else {
        endDrag(false)
      }
    },
    onCancel: () => endDrag(false),
  })

  return (
    <div
      aria-hidden="true"
      data-slot="sheet-handle"
      className={cn(
        // Absolute overlay under SheetHeader (z-0 vs header z-10). Interactive
        // header children opt in with data-sheet-interactive so presses on the
        // title or empty header space still reach this grab target.
        "absolute inset-x-0 top-0 z-0 flex h-11 cursor-grab touch-none justify-center pt-1.5 active:cursor-grabbing",
        className,
      )}
      {...props}
      onPointerDown={(event) => {
        props.onPointerDown?.(event)
        if (event.defaultPrevented) return
        start(event)
      }}
    >
      <span className="h-1 w-10 rounded-full bg-muted-foreground/50" />
    </div>
  )
}

export interface SheetHeaderProps extends React.ComponentProps<"div"> {}

/**
 * The sheet's title row. Hosts place SheetClose or SheetExpand, SheetTitle,
 * and SheetAction as children; the side columns share leftover width so the
 * title stays optically centered whether or not the side controls are present.
 *
 * The row sits over SheetHandle's absolute drag target and is pointer-events
 * none by default. SheetClose, SheetExpand, and SheetAction set
 * `data-sheet-interactive` so they receive presses; custom interactive
 * children need the same attribute (or their own pointer-events) or the grab
 * bar will eat the gesture.
 */
function SheetHeader({ className, ...props }: SheetHeaderProps) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        // The side controls sit a little outside the body's own margin: a circle
        // whose bounding box is flush with straight text reads as indented, so
        // it is outdented by half its overhang to line up optically.
        "relative z-10 grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pb-2 pt-4",
        // Opt-in only: tag-name allowlists would miss custom controls and
        // would steal presses from the absolute SheetHandle underneath.
        "pointer-events-none [&_[data-sheet-interactive]]:pointer-events-auto",
        className,
      )}
      {...props}
    />
  )
}

export interface SheetTitleProps extends React.ComponentProps<"h2"> {}

/** The sheet's heading, centered in the header. */
function SheetTitle({ className, ...props }: SheetTitleProps) {
  return (
    <h2
      data-slot="sheet-title"
      className={cn(
        "col-start-2 m-0 min-w-0 truncate text-center font-sans nessa-text-5 font-semibold text-foreground",
        className,
      )}
      {...props}
    />
  )
}

const sheetControlClassName =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-muted text-foreground outline-none transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5"

/**
 * The circular dismiss control. Closes the enclosing sheet, so hosts pass
 * no handler unless they need to intercept the click.
 */
function SheetClose({
  className,
  children,
  onClick,
  "aria-label": ariaLabel = "Close",
  ...props
}: React.ComponentProps<"button">) {
  const { close } = useSheet()
  return (
    <button
      type="button"
      data-slot="sheet-close"
      data-sheet-interactive=""
      aria-label={ariaLabel}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) close()
      }}
      className={cn(sheetControlClassName, "col-start-1 justify-self-start", className)}
      {...props}
    >
      {children ?? <X aria-hidden="true" />}
    </button>
  )
}

/**
 * Toggles the panel between the bottom drawer and a surface that fills the
 * sheet's positioned ancestor. The same control reads Expand or Minimize.
 */
function SheetExpand({
  className,
  onClick,
  ...props
}: React.ComponentProps<"button">) {
  const { expanded, setExpanded } = useSheet()
  return (
    <button
      type="button"
      data-slot="sheet-expand"
      data-sheet-interactive=""
      aria-label={expanded ? "Minimize" : "Expand"}
      aria-expanded={expanded}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) setExpanded(!expanded)
      }}
      className={cn(sheetControlClassName, "col-start-1 justify-self-start", className)}
      {...props}
    >
      {expanded ? (
        <Minimize2 aria-hidden="true" />
      ) : (
        <Maximize2 aria-hidden="true" />
      )}
    </button>
  )
}

/**
 * A trailing header control — typically "Done". Closes the enclosing sheet
 * unless the click is cancelled.
 */
function SheetAction({
  className,
  children = "Done",
  onClick,
  ...props
}: React.ComponentProps<"button">) {
  const { close } = useSheet()
  return (
    <button
      type="button"
      data-slot="sheet-action"
      data-sheet-interactive=""
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) close()
      }}
      className={cn(
        "col-start-3 inline-flex h-8 min-w-8 cursor-pointer items-center justify-center justify-self-end rounded-full border-0 bg-muted px-2.5 font-sans nessa-text-3 font-semibold text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/**
 * The sheet's scrolling body. Fills under the header while expanded or while a
 * drag is stretching the panel; otherwise it sizes to its content and scrolls
 * only when that content would exceed the panel's max height. Scrollbars stay
 * visible while collapsed (mouse affordance) and hide once the panel fills the
 * frame. Overscroll is contained so the sheet cannot rubber-band past its
 * content into empty space.
 */
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  const { expanded, dragging } = useSheet()
  const filled = expanded || dragging
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        "flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-6 pb-6 pt-2",
        filled && "flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetAction,
  SheetBody,
  SheetClose,
  SheetExpand,
  SheetHandle,
  SheetHeader,
  SheetTitle,
  useSheet,
}
