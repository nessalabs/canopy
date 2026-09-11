import * as React from "react"
import { ChevronRight } from "lucide-react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

export type SelectionTooltipSide = "top" | "bottom"

interface SelectionTooltipContextValue {
  expanded: boolean
  /**
   * Requests a shelf reveal or collapse. Collapsing while focus is inside the
   * shelf moves focus back to the SelectionTooltipMore toggle first, so
   * keyboard users never lose their place to a hidden element.
   */
  setExpanded: (expanded: boolean) => void
  shelfId: string
  shelfMounted: boolean
  setShelfMounted: (mounted: boolean) => void
  moreRef: React.RefObject<HTMLButtonElement | null>
  shelfRef: React.RefObject<HTMLDivElement | null>
  shelfHadFocusRef: React.RefObject<boolean>
}

const SelectionTooltipContext =
  React.createContext<SelectionTooltipContextValue | null>(null)

/**
 * Shelf state for the surrounding SelectionTooltip, exposed so hosts can
 * collapse the shelf after acting on one of its items. Must be called under a
 * SelectionTooltip.
 */
function useSelectionTooltip(): SelectionTooltipContextValue {
  const context = React.useContext(SelectionTooltipContext)
  if (context === null) {
    throw new Error(
      "useSelectionTooltip must be used within a SelectionTooltip",
    )
  }
  return context
}

export interface SelectionTooltipProps
  extends Omit<React.ComponentProps<"div">, "aria-label"> {
  /** Accessible name for the action group. Defaults to "Selection actions". */
  "aria-label"?: string
  /**
   * Which side of the target the tooltip floats on; the arrow points at the
   * opposite edge. `top` (the default) draws the arrow underneath. Exposed as
   * `data-side` for host styling.
   */
  side?: SelectionTooltipSide
  /** Hides the pointer arrow when false. */
  arrow?: boolean
  /** Controls the SelectionTooltipShelf reveal; omit for uncontrolled use. */
  expanded?: boolean
  /** Initial shelf reveal for uncontrolled use. */
  defaultExpanded?: boolean
  /**
   * Called with the requested reveal whenever SelectionTooltipMore or
   * `setExpanded` from useSelectionTooltip toggles the shelf, in controlled
   * and uncontrolled use alike.
   */
  onExpandedChange?: (expanded: boolean) => void
}

/**
 * A floating selection-callout pill, in the spirit of the iOS text-selection
 * menu: SelectionTooltipAction buttons separated by SelectionTooltipSeparator
 * rules, a SelectionTooltipMore chevron, and a SelectionTooltipShelf that the
 * chevron reveals. Purely presentational — the host positions it over the
 * selection (it is not portalled and does no anchoring), and what each action
 * does stays host-owned through `onClick`. To swap the pill into another
 * state, such as writing a comment after a Comment action, render different
 * children; only the shelf reveal is managed here. Expanding keeps the pill
 * at its collapsed width — SelectionTooltipLabels hide, the shelf fills the
 * freed space and scrolls, and the chevron never moves, so collapsing again
 * needs no cursor travel.
 */
function SelectionTooltip({
  "aria-label": ariaLabel = "Selection actions",
  side = "top",
  arrow = true,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  className,
  style,
  ref,
  children,
  ...props
}: SelectionTooltipProps) {
  const shelfId = React.useId()
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const collapsedWidthRef = React.useRef<number | null>(null)
  const moreRef = React.useRef<HTMLButtonElement | null>(null)
  const shelfRef = React.useRef<HTMLDivElement | null>(null)
  const shelfHadFocusRef = React.useRef(false)
  const [shelfMounted, setShelfMounted] = React.useState(false)
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    React.useState(defaultExpanded)
  const isControlled = expanded !== undefined
  const resolvedExpanded = expanded ?? uncontrolledExpanded
  const setExpanded = React.useCallback(
    (next: boolean) => {
      // Re-measure at the moment of expansion, while the pill is still
      // collapsed: commit-time measurements go stale when late layout shifts
      // (a web font swapping in) resize the pill without a React commit.
      if (next && !previousExpandedRef.current && rootRef.current !== null) {
        const width = rootRef.current.getBoundingClientRect().width
        // A hidden pill measures 0; locking that would collapse the pill
        // entirely, so only positive measurements replace the last good one.
        if (width > 0) collapsedWidthRef.current = width
      }
      // Rescue focus before the shelf goes display:none, while its focused
      // item is still visible and focusable.
      if (
        !next &&
        shelfRef.current !== null &&
        shelfRef.current.contains(document.activeElement)
      ) {
        moreRef.current?.focus()
      }
      if (!isControlled) setUncontrolledExpanded(next)
      onExpandedChange?.(next)
    },
    [isControlled, onExpandedChange],
  )
  // Covers the controlled path, where a host flips `expanded` without going
  // through setExpanded: by this point the shelf is already hidden and focus
  // has fallen to the body, so the shelf's own focus tracking says whether it
  // held focus a moment ago.
  const previousExpandedRef = React.useRef(resolvedExpanded)
  React.useLayoutEffect(() => {
    if (previousExpandedRef.current && !resolvedExpanded) {
      // Focus lost to the hidden shelf lands on the host root; anywhere else
      // means the user has since focused something real, which is kept.
      const active = document.activeElement
      if (
        shelfHadFocusRef.current &&
        (active === null || active.tagName === "BODY")
      ) {
        moreRef.current?.focus()
      }
      shelfHadFocusRef.current = false
    }
    previousExpandedRef.current = resolvedExpanded
  }, [resolvedExpanded])
  // Remember the collapsed width every commit spent collapsed, so the moment
  // the pill expands it can hold exactly that width: the chevron stays put
  // and the shelf scrolls inside the freed space instead of widening the
  // pill.
  React.useLayoutEffect(() => {
    if (!resolvedExpanded) {
      // Subpixel-exact width, so locking it cannot shift the pill by the
      // fraction offsetWidth would round away. A hidden pill measures 0 and
      // is skipped, keeping the last good measurement.
      const width = rootRef.current?.getBoundingClientRect().width
      if (width !== undefined && width > 0) collapsedWidthRef.current = width
    }
  })
  // Commit-time measurements alone go stale when layout shifts without a
  // React commit (a web font swapping in). setExpanded re-measures for the
  // toggle path; this observer keeps the measurement fresh for controlled
  // hosts that flip `expanded` directly.
  React.useLayoutEffect(() => {
    const node = rootRef.current
    if (resolvedExpanded || node === null) return
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      const width = node.getBoundingClientRect().width
      // A pill hidden via CSS resizes to 0; that must not poison the lock.
      if (width > 0) collapsedWidthRef.current = width
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [resolvedExpanded])
  const composedRef = React.useCallback(
    (node: HTMLDivElement) => {
      rootRef.current = node
      let consumerCleanup: (() => void) | void
      if (typeof ref === "function") consumerCleanup = ref(node)
      else if (ref) ref.current = node
      return () => {
        rootRef.current = null
        if (typeof consumerCleanup === "function") consumerCleanup()
        else if (typeof ref === "function") ref(null)
        else if (ref) ref.current = null
      }
    },
    [ref],
  )
  const lockedWidth = resolvedExpanded ? collapsedWidthRef.current : null
  const context = React.useMemo(
    () => ({
      expanded: resolvedExpanded,
      setExpanded,
      shelfId,
      shelfMounted,
      setShelfMounted,
      moreRef,
      shelfRef,
      shelfHadFocusRef,
    }),
    [resolvedExpanded, setExpanded, shelfId, shelfMounted],
  )
  return (
    <SelectionTooltipContext.Provider value={context}>
      <div
        role="group"
        aria-label={ariaLabel}
        ref={composedRef}
        style={lockedWidth === null ? style : { width: lockedWidth, ...style }}
        data-slot="selection-tooltip"
        data-side={side}
        data-expanded={resolvedExpanded ? "true" : "false"}
        className={cn(
          "group/selection-tooltip relative inline-flex w-fit max-w-full items-stretch gap-0.5 rounded-xl border border-border bg-popover p-1 font-sans text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      >
        {children}
        {arrow && (
          <span
            aria-hidden="true"
            data-slot="selection-tooltip-arrow"
            className={cn(
              "pointer-events-none absolute left-1/2 size-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-popover",
              side === "top" &&
                "top-full -translate-y-1/2 border-b border-r border-border",
              side === "bottom" &&
                "bottom-full translate-y-1/2 border-l border-t border-border",
            )}
          />
        )}
      </div>
    </SelectionTooltipContext.Provider>
  )
}

export interface SelectionTooltipActionProps
  extends React.ComponentProps<"button"> {
  /**
   * Hover/focus tooltip naming the action — keep it a short label. Portalled
   * with an arrow pointing back at the action, so it escapes the shelf's
   * overflow clipping. Icon-only actions should carry one alongside their
   * `aria-label`.
   */
  tooltip?: React.ReactNode
}

/**
 * One action in the pill. Children carry the label — text, an icon, or both;
 * icon-only actions must name themselves with `aria-label` and should
 * describe themselves with `tooltip`. Wrapping the visible text in
 * SelectionTooltipLabel collapses the action to its icon while the shelf is
 * expanded. What clicking it does stays host-owned through `onClick`. The
 * focus outline draws inset so the shelf's overflow clipping can never
 * swallow it.
 */
function SelectionTooltipAction({
  tooltip,
  className,
  type = "button",
  ...props
}: SelectionTooltipActionProps) {
  const button = (
    <button
      type={type}
      data-slot="selection-tooltip-action"
      className={cn(
        "inline-flex h-8 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-lg border-0 bg-transparent px-2.5 nessa-text-4 font-medium text-popover-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
  if (tooltip == null) return button
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            sideOffset={6}
            data-slot="selection-tooltip-action-tip"
            className="z-50 max-w-56 rounded-lg bg-primary px-2.5 py-1 text-center font-sans nessa-text-2 font-medium text-primary-foreground shadow-md"
          >
            {tooltip}
            <TooltipPrimitive.Arrow
              width={10}
              height={5}
              className="fill-primary"
            />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

export interface SelectionTooltipLabelProps
  extends React.ComponentProps<"span"> {}

/**
 * The visible text of an action that collapses to icon-only while the shelf
 * is expanded, keeping the pill compact once the extra items appear. The span
 * is presentation-only (`aria-hidden`): give the surrounding action a
 * matching `aria-label`, since its accessible name must survive the label
 * hiding.
 */
function SelectionTooltipLabel({
  className,
  ...props
}: SelectionTooltipLabelProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="selection-tooltip-label"
      className={cn(
        "group-data-[expanded=true]/selection-tooltip:hidden",
        className,
      )}
      {...props}
    />
  )
}

export interface SelectionTooltipSeparatorProps
  extends React.ComponentProps<"span"> {}

/** The hairline rule between actions. */
function SelectionTooltipSeparator({
  className,
  ...props
}: SelectionTooltipSeparatorProps) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      data-slot="selection-tooltip-separator"
      className={cn("my-1.5 w-px shrink-0 self-stretch bg-border", className)}
      {...props}
    />
  )
}

export interface SelectionTooltipMoreProps
  extends Omit<React.ComponentProps<"button">, "children" | "aria-label"> {
  /** Accessible name for the toggle. Defaults to "More actions". */
  "aria-label"?: string
}

/**
 * The chevron toggle that reveals the SelectionTooltipShelf. The chevron
 * turns to point back at the pill while the shelf is open, and the reveal
 * state lives on the surrounding SelectionTooltip. Compose it after the
 * shelf — `…actions, Shelf, More` — so the toggle holds the pill's right
 * edge and the shelf expands between the always-visible actions and it.
 */
function SelectionTooltipMore({
  "aria-label": ariaLabel = "More actions",
  className,
  type = "button",
  onClick,
  ref,
  ...props
}: SelectionTooltipMoreProps) {
  const { expanded, setExpanded, shelfId, shelfMounted, moreRef } =
    useSelectionTooltip()
  // Forwards to the consumer's ref while honoring the callback-ref cleanup
  // contract: a consumer-returned cleanup is invoked on detach, otherwise
  // callback refs are called with `null` and object refs are reset.
  const composedRef = React.useCallback(
    (node: HTMLButtonElement) => {
      moreRef.current = node
      let consumerCleanup: (() => void) | void
      if (typeof ref === "function") consumerCleanup = ref(node)
      else if (ref) ref.current = node
      return () => {
        moreRef.current = null
        if (typeof consumerCleanup === "function") consumerCleanup()
        else if (typeof ref === "function") ref(null)
        else if (ref) ref.current = null
      }
    },
    [moreRef, ref],
  )
  return (
    <button
      type={type}
      ref={composedRef}
      aria-label={ariaLabel}
      aria-expanded={expanded}
      aria-controls={shelfMounted ? shelfId : undefined}
      data-slot="selection-tooltip-more"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-popover-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform aria-expanded:[&_svg]:rotate-180",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) setExpanded(!expanded)
      }}
      {...props}
    >
      <ChevronRight aria-hidden="true" />
    </button>
  )
}

export interface SelectionTooltipShelfProps
  extends Omit<React.ComponentProps<"div">, "aria-label"> {
  /** Accessible name for the shelf region. Defaults to "More actions". */
  "aria-label"?: string
}

/**
 * The horizontally scrollable tray of extra items that SelectionTooltipMore
 * reveals, its scrollbar hidden so the pill stays clean. Children are
 * arbitrary components — more actions, pickers, whole controls. It fills the
 * space the pill's collapsed width allows (the pill does not widen on
 * expand), scrolling whatever overflows. The shelf itself takes keyboard
 * focus, keeping the scroll region operable even when its content is not.
 * Hidden entirely while collapsed.
 */
function SelectionTooltipShelf({
  "aria-label": ariaLabel = "More actions",
  className,
  ref,
  onFocus,
  onBlur,
  ...props
}: SelectionTooltipShelfProps) {
  const { expanded, shelfId, setShelfMounted, shelfRef, shelfHadFocusRef } =
    useSelectionTooltip()
  React.useLayoutEffect(() => {
    setShelfMounted(true)
    return () => setShelfMounted(false)
  }, [setShelfMounted])
  // Forwards to the consumer's ref while honoring the callback-ref cleanup
  // contract: a consumer-returned cleanup is invoked on detach, otherwise
  // callback refs are called with `null` and object refs are reset.
  const composedRef = React.useCallback(
    (node: HTMLDivElement) => {
      shelfRef.current = node
      let consumerCleanup: (() => void) | void
      if (typeof ref === "function") consumerCleanup = ref(node)
      else if (ref) ref.current = node
      return () => {
        shelfRef.current = null
        if (typeof consumerCleanup === "function") consumerCleanup()
        else if (typeof ref === "function") ref(null)
        else if (ref) ref.current = null
      }
    },
    [ref, shelfRef],
  )
  return (
    <div
      id={shelfId}
      role="group"
      aria-label={ariaLabel}
      tabIndex={0}
      ref={composedRef}
      onFocus={(event) => {
        onFocus?.(event)
        shelfHadFocusRef.current = true
      }}
      onBlur={(event) => {
        onBlur?.(event)
        // Focus leaving for another element clears the flag; a blur straight
        // to the body keeps it, because that is what hiding the shelf looks
        // like and the collapse effect needs to know focus was in here.
        if (
          event.relatedTarget !== null &&
          shelfRef.current !== null &&
          !shelfRef.current.contains(event.relatedTarget)
        ) {
          shelfHadFocusRef.current = false
        }
      }}
      data-slot="selection-tooltip-shelf"
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "min-w-0 grow items-center gap-0.5 overflow-x-auto outline-none [-ms-overflow-style:none] [scrollbar-width:none] focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-scrollbar]:hidden",
        expanded ? "flex" : "hidden",
        className,
      )}
      {...props}
    />
  )
}

export {
  SelectionTooltip,
  SelectionTooltipAction,
  SelectionTooltipLabel,
  SelectionTooltipMore,
  SelectionTooltipSeparator,
  SelectionTooltipShelf,
  useSelectionTooltip,
}
