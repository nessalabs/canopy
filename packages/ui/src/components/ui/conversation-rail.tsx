import * as React from "react"

import { cn } from "@/lib/utils"

/** `useLayoutEffect` in the browser, `useEffect` during SSR (no-op there). */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * Registers a rail item with its owning `ConversationRail` so pointer
 * tracking can iterate real elements instead of querying the DOM. Returns a
 * cleanup that unregisters the element.
 */
type ConversationRailRegisterItem = (element: HTMLElement) => () => void

const ConversationRailContext =
  React.createContext<ConversationRailRegisterItem | null>(null)

/**
 * Per-item state shared between a rail item and the trigger, marker, and
 * preview composed inside it.
 */
interface ConversationRailItemContextValue {
  /**
   * Id of the mounted `ConversationRailPreview`, linked from the trigger via
   * `aria-describedby`; `null` while the item has no preview.
   */
  previewId: string | null
  /** Registers (or with `null`, unregisters) the item's preview id. */
  setPreviewId: (previewId: string | null) => void
  /** Whether the host marked this turn as the active one. */
  active: boolean
  /**
   * Hides the preview until it is re-armed (turn clicked or Escape pressed).
   */
  suppressPreview: () => void
  /** Re-arms a suppressed preview (fresh pointer approach or blur). */
  releasePreview: () => void
}

const ConversationRailItemContext =
  React.createContext<ConversationRailItemContextValue | null>(null)

/**
 * Reads the surrounding item's context.
 *
 * @param consumer - Component name used in the error when rendered outside a
 * `ConversationRailItem`.
 */
function useConversationRailItem(consumer: string) {
  const context = React.useContext(ConversationRailItemContext)
  if (!context) {
    throw new Error(`${consumer} must be used within a ConversationRailItem.`)
  }
  return context
}

export interface ConversationRailProps extends React.ComponentProps<"nav"> {
  /**
   * Enables the pointer-proximity hill. When disabled, markers only respond
   * to their own row's hover, focus, and active states.
   *
   * @default true
   */
  proximity?: boolean
  /**
   * Vertical distance in pixels from the pointer at which a marker stops
   * widening. Smaller values make a tighter spike; larger values a wider
   * hill.
   *
   * @default 32
   */
  proximityRadius?: number
  /**
   * Maps a marker's distance from the pointer to a boost in `[0, 1]`, where
   * `1` fully opens the marker and `0` leaves it at rest. Replace it to
   * reshape the hill; results are clamped to `[0, 1]`.
   *
   * @default A squared raised cosine: `((1 + cos(pi * d / r)) / 2) ** 2`.
   */
  proximityFalloff?: (distance: number, radius: number) => number
}

/**
 * Default hill shape. Squaring the raised cosine keeps the peak tall while
 * making the neighbors fall away from it at a steeper rate.
 *
 * @param distance - Vertical distance in pixels between the pointer and a
 * marker's center.
 * @param radius - `proximityRadius`; boosts are `0` at or beyond it.
 * @returns A boost in `[0, 1]`.
 */
function defaultProximityFalloff(distance: number, radius: number) {
  if (distance >= radius) return 0
  return ((1 + Math.cos((distance / radius) * Math.PI)) / 2) ** 2
}

/**
 * An edge-mounted navigator for conversation turns.
 *
 * Renders a `nav` with a vertical list of `ConversationRailItem` children.
 * As the pointer moves along the list, each registered item receives a
 * `--nessa-rail-boost` custom property computed by `proximityFalloff` from
 * its distance to the pointer, raising a hill of widths centered on the
 * cursor. The variable is inherited, so default markers and custom rows can
 * both consume it.
 *
 * Updates are batched to animation frames with geometry reads separated
 * from style writes. The hill is skipped for touch pointers and under
 * `prefers-reduced-motion`, and boosts clear when the pointer leaves the
 * list, the pointer is cancelled, or `proximity` turns off — per-row hover,
 * focus, and active states remain CSS-driven and unaffected.
 */
function ConversationRail({
  proximity = true,
  proximityRadius = 32,
  proximityFalloff = defaultProximityFalloff,
  className,
  children,
  ...props
}: ConversationRailProps) {
  const itemsRef = React.useRef(new Set<HTMLElement>())
  const frameRef = React.useRef(0)
  const pointerYRef = React.useRef(0)
  const reducedMotionRef = React.useRef(false)
  // Read by the scheduled frame so a pending pass always uses the latest
  // tuning props instead of the ones captured when it was scheduled.
  const falloffRef = React.useRef(proximityFalloff)
  const radiusRef = React.useRef(proximityRadius)

  useIsomorphicLayoutEffect(() => {
    falloffRef.current = proximityFalloff
    radiusRef.current = proximityRadius
  }, [proximityFalloff, proximityRadius])

  const registerItem = React.useCallback<ConversationRailRegisterItem>(
    (element) => {
      itemsRef.current.add(element)
      return () => {
        itemsRef.current.delete(element)
      }
    },
    [],
  )

  /** Cancels any pending frame and settles every marker back to rest. */
  const clearProximity = React.useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    for (const item of itemsRef.current) {
      item.style.removeProperty("--nessa-rail-boost")
    }
  }, [])

  /**
   * Records the pointer position and schedules one boost pass for the next
   * animation frame. The pass reads every item's geometry first, then
   * applies the style writes, so reads and writes never interleave. Set
   * imperatively (rather than through state) so continuous pointer movement
   * does not re-render the tree.
   */
  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLOListElement>) => {
      if (
        !proximity ||
        reducedMotionRef.current ||
        event.pointerType === "touch"
      ) {
        clearProximity()
        return
      }
      pointerYRef.current = event.clientY
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0
        const pointerY = pointerYRef.current
        const boosts: [HTMLElement, number][] = []
        for (const item of itemsRef.current) {
          const rect = item.getBoundingClientRect()
          const distance = Math.abs(pointerY - (rect.top + rect.height / 2))
          boosts.push([
            item,
            Math.min(
              1,
              Math.max(0, falloffRef.current(distance, radiusRef.current)),
            ),
          ])
        }
        for (const [item, boost] of boosts) {
          if (boost > 0) {
            item.style.setProperty("--nessa-rail-boost", boost.toFixed(3))
          } else {
            item.style.removeProperty("--nessa-rail-boost")
          }
        }
      })
    },
    [proximity, clearProximity],
  )

  // Track prefers-reduced-motion so the pointer hill pauses while it is on,
  // settling any hill that was already raised when the preference turns on.
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => {
      reducedMotionRef.current = query.matches
      if (query.matches) clearProximity()
    }
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [clearProximity])

  // Settle the rail whenever the hill is turned off, and on unmount so no
  // scheduled frame outlives the component.
  React.useEffect(() => {
    if (!proximity) clearProximity()
    return clearProximity
  }, [proximity, clearProximity])

  return (
    <nav
      data-slot="conversation-rail"
      aria-label="Conversation timeline"
      className={cn("font-sans", className)}
      {...props}
    >
      <ConversationRailContext.Provider value={registerItem}>
        <ol
          onPointerMove={handlePointerMove}
          onPointerLeave={clearProximity}
          onPointerCancel={clearProximity}
          className="m-0 flex list-none flex-col items-start p-0"
        >
          {children}
        </ol>
      </ConversationRailContext.Provider>
    </nav>
  )
}

export interface ConversationRailItemProps extends React.ComponentProps<"li"> {
  /**
   * Marks this turn as the current one. The host owns selection: feed it
   * from a click handler, a router, or message visibility (for example an
   * `IntersectionObserver` over the scrolled chat). Active rows are tinted
   * but stay at their resting width.
   *
   * @default false
   */
  active?: boolean
}

/**
 * One turn in the rail. Wraps a `ConversationRailTrigger` (and optionally a
 * `ConversationRailPreview`) and exposes its state to them through context
 * and to CSS through the `data-active` and `data-preview-suppressed`
 * attributes on the rendered `li` (a `group/rail-item` scope). Registers
 * its element with the owning rail for pointer-proximity tracking.
 */
function ConversationRailItem({
  active = false,
  className,
  onPointerEnter,
  ref,
  ...props
}: ConversationRailItemProps) {
  const registerItem = React.useContext(ConversationRailContext)
  /**
   * Registers the element with the rail and forwards it to the consumer's
   * ref, honoring the callback-ref cleanup contract: a consumer-returned
   * cleanup is invoked on detach, otherwise callback refs are called with
   * `null` and object refs are reset.
   */
  const composedRef = React.useCallback(
    (element: HTMLLIElement) => {
      const unregister = registerItem?.(element)
      let consumerCleanup: (() => void) | void
      if (typeof ref === "function") consumerCleanup = ref(element)
      else if (ref) ref.current = element
      return () => {
        unregister?.()
        if (typeof consumerCleanup === "function") consumerCleanup()
        else if (typeof ref === "function") ref(null)
        else if (ref) ref.current = null
      }
    },
    [registerItem, ref],
  )
  const [previewId, setPreviewId] = React.useState<string | null>(null)
  const [previewSuppressed, setPreviewSuppressed] = React.useState(false)
  const context = React.useMemo(
    () => ({
      previewId,
      setPreviewId,
      active,
      suppressPreview: () => setPreviewSuppressed(true),
      releasePreview: () => setPreviewSuppressed(false),
    }),
    [previewId, active],
  )

  return (
    <ConversationRailItemContext.Provider value={context}>
      <li
        ref={composedRef}
        data-slot="conversation-rail-item"
        data-active={active ? "true" : "false"}
        data-preview-suppressed={previewSuppressed ? "true" : "false"}
        onPointerEnter={(event) => {
          // A fresh pointer approach re-arms the preview. Releasing on leave
          // instead would let the click-focused row pop back open with no
          // hover, since the trigger keeps focus after a click.
          setPreviewSuppressed(false)
          onPointerEnter?.(event)
        }}
        className={cn("group/rail-item relative flex items-center", className)}
        {...props}
      />
    </ConversationRailItemContext.Provider>
  )
}

export interface ConversationRailTriggerProps
  extends React.ComponentProps<"button"> {}

/**
 * The interactive control for a turn. A plain button: what selecting a turn
 * does is entirely the host's `onClick` (scroll to the message, load a
 * thread, and so on).
 *
 * Renders a `ConversationRailMarker` when no children are given; pass any
 * custom row content as children instead. Exposes `aria-current` while the
 * item is active, and `aria-describedby` linking the item's mounted preview
 * (merged with any host-supplied value). Clicking or pressing Escape
 * suppresses the preview; blurring re-arms it.
 */
function ConversationRailTrigger({
  className,
  children,
  onClick,
  onBlur,
  onKeyDown,
  "aria-describedby": ariaDescribedBy,
  ...props
}: ConversationRailTriggerProps) {
  const { previewId, active, suppressPreview, releasePreview } =
    useConversationRailItem("ConversationRailTrigger")
  const describedByTokens = new Set(
    [previewId, ...(ariaDescribedBy ?? "").split(/\s+/)].filter(Boolean),
  ) as Set<string>
  const describedBy = describedByTokens.size
    ? [...describedByTokens].join(" ")
    : undefined

  return (
    <button
      type="button"
      data-slot="conversation-rail-trigger"
      data-active={active ? "true" : "false"}
      aria-current={active ? "true" : undefined}
      aria-describedby={describedBy}
      onClick={(event) => {
        suppressPreview()
        onClick?.(event)
      }}
      onKeyDown={(event) => {
        // Tooltip-style content must be dismissible without moving focus.
        if (event.key === "Escape") suppressPreview()
        onKeyDown?.(event)
      }}
      onBlur={(event) => {
        releasePreview()
        onBlur?.(event)
      }}
      className={cn(
        "flex h-3 w-9 items-center justify-start rounded-sm border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {children ?? <ConversationRailMarker />}
    </button>
  )
}

export interface ConversationRailMarkerProps
  extends React.ComponentProps<"span"> {}

/**
 * The default tick for a turn: a thin bar whose width interpolates between
 * rest and fully open.
 *
 * Sizing is variable-driven so one knob retunes every state:
 * - `--nessa-rail-marker-max` — fully open width (default `1.75rem`).
 * - `--nessa-rail-marker-base-ratio` — resting width as a fraction of the
 *   max (default `0.25`).
 * - `--nessa-rail-boost` — hill boost inherited from the item, set by
 *   `ConversationRail` pointer tracking.
 * - `--nessa-rail-boost-state` — pinned to `1` while the row is hovered, or
 *   keyboard-focused (`:focus-visible`) with its preview not suppressed.
 *
 * The marker is decorative (`aria-hidden`); the trigger carries the
 * accessible name.
 */
function ConversationRailMarker({
  className,
  ...props
}: ConversationRailMarkerProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="conversation-rail-marker"
      className={cn(
        "block h-0.5 rounded-full bg-muted-foreground/50 transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none",
        "[width:calc(var(--nessa-rail-marker-max,1.75rem)*(var(--nessa-rail-marker-base-ratio,0.25)_+_max(var(--nessa-rail-boost,0),var(--nessa-rail-boost-state,0))*(1_-_var(--nessa-rail-marker-base-ratio,0.25))))]",
        "group-hover/rail-item:[--nessa-rail-boost-state:1] group-hover/rail-item:bg-foreground group-[[data-preview-suppressed=false]:has(:focus-visible)]/rail-item:[--nessa-rail-boost-state:1] group-[[data-preview-suppressed=false]:has(:focus-visible)]/rail-item:bg-foreground group-data-[active=true]/rail-item:bg-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface ConversationRailPreviewProps
  extends React.ComponentProps<"div"> {}

/**
 * A floating card describing the turn, shown beside the rail while its row
 * is hovered or keyboard-focused (`:focus-visible`). Mouse focus alone never
 * reveals it; clicking the trigger or pressing Escape dismisses it until a
 * fresh pointer approach or blur re-arms it — so a clicked row cannot stay
 * stuck open.
 *
 * While revealed the card is hit-testable (with a bridge over the gap to
 * the rail) so the pointer can move onto it without it disappearing; when
 * hidden it is inert. It stays semantically non-interactive
 * (`role="tooltip"`) — put actions in the trigger, not here. Registers its
 * id (a host-supplied `id` wins over the generated one) with the item so
 * the trigger gains `aria-describedby`.
 */
function ConversationRailPreview({
  id: idProp,
  className,
  ...props
}: ConversationRailPreviewProps) {
  const { setPreviewId } = useConversationRailItem("ConversationRailPreview")
  const generatedId = React.useId()
  const id = idProp ?? generatedId

  React.useEffect(() => {
    setPreviewId(id)
    return () => setPreviewId(null)
  }, [id, setPreviewId])

  return (
    <div
      id={id}
      role="tooltip"
      data-slot="conversation-rail-preview"
      className={cn(
        "pointer-events-none absolute left-full top-1/2 z-50 ml-2 w-64 -translate-x-1 -translate-y-1/2 rounded-xl border border-border bg-popover p-3 text-left nessa-text-4 text-popover-foreground opacity-0 shadow-lg transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none",
        "before:absolute before:inset-y-0 before:-left-2 before:w-2 before:content-['']",
        "group-[[data-preview-suppressed=false]:hover]/rail-item:pointer-events-auto group-[[data-preview-suppressed=false]:hover]/rail-item:translate-x-0 group-[[data-preview-suppressed=false]:hover]/rail-item:opacity-100 group-[[data-preview-suppressed=false]:has(:focus-visible)]/rail-item:pointer-events-auto group-[[data-preview-suppressed=false]:has(:focus-visible)]/rail-item:translate-x-0 group-[[data-preview-suppressed=false]:has(:focus-visible)]/rail-item:opacity-100",
        className,
      )}
      {...props}
    />
  )
}

export {
  ConversationRail,
  ConversationRailItem,
  ConversationRailMarker,
  ConversationRailPreview,
  ConversationRailTrigger,
}
