"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "./button"
import { JsonTree } from "./json-tree"

/**
 * Where the approval card lives:
 *
 * - `docked` — full width, meant to sit directly above the chat composer.
 * - `floating` — a compact free-standing panel for overlay or mobile use.
 * - `notch` — a top-anchored drop-down whose square top edge meets the
 *   display bezel and whose bottom corners round off below it.
 */
export type ToolApprovalVariant = "docked" | "floating" | "notch"

/**
 * The decision's outcome once made. Setting it on the card marks the request
 * resolved: actions go inert, the exit motion plays, and `onExited` tells the
 * host when to unmount and show what comes next — a running tool row, a
 * denied note, whatever the surface calls for.
 */
export type ToolApprovalResolution = "allowed" | "denied"

/** Matches the reduced-motion media query used across Nessa motion surfaces. */
const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

/** Parses a CSS duration token value into milliseconds. */
function cssDurationInMilliseconds(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return value.trim().endsWith("ms") ? parsed : parsed * 1000
}

/**
 * Each variant's entrance in one place: the notch slides down from behind its
 * anchor edge on the slow token, the others rise and fade in on the normal
 * token. Keeping token, fallback, and keyframes together means a new variant
 * adds one entry here instead of edits scattered through the effect.
 */
const entranceByVariant: Record<
  ToolApprovalVariant,
  { durationToken: string; fallback: number; keyframes: Keyframe[] }
> = {
  docked: {
    durationToken: "--nessa-motion-duration-normal",
    fallback: 200,
    keyframes: [
      { opacity: 0, translate: "0 0.5rem" },
      { opacity: 1, translate: "0 0" },
    ],
  },
  floating: {
    durationToken: "--nessa-motion-duration-normal",
    fallback: 200,
    keyframes: [
      { opacity: 0, translate: "0 0.5rem" },
      { opacity: 1, translate: "0 0" },
    ],
  },
  notch: {
    durationToken: "--nessa-motion-duration-slow",
    fallback: 300,
    keyframes: [{ translate: "0 -100%" }, { translate: "0 0" }],
  },
}

/**
 * Each variant's exit mirrors its entrance: the notch slides back up behind
 * its anchor edge, the others sink and fade. Only the destination frame is
 * declared — the exit starts from the card's LIVE computed values, so
 * resolving mid-entrance hands off smoothly instead of snapping to rest
 * first. `fill: "forwards"` in the exit player keeps the card at the final
 * frame until the host unmounts it.
 */
const exitByVariant: Record<
  ToolApprovalVariant,
  { durationToken: string; fallback: number; to: Keyframe }
> = {
  docked: {
    durationToken: "--nessa-motion-duration-normal",
    fallback: 200,
    to: { opacity: 0, translate: "0 0.375rem" },
  },
  floating: {
    durationToken: "--nessa-motion-duration-normal",
    fallback: 200,
    to: { opacity: 0, translate: "0 0.375rem" },
  },
  notch: {
    durationToken: "--nessa-motion-duration-slow",
    fallback: 300,
    // Translate only: the notch slides away without touching opacity, so a
    // host-applied dim (a className, an inherited fade) stays in force. Its
    // held frame sits fully above the anchor edge — hosts clip that region,
    // as a real bezel does.
    to: { translate: "0 -100%" },
  },
}

/**
 * Plays the card's entrance exactly once, on mount, for the variant the card
 * mounted with — later variant changes restyle in place without replaying.
 * The reduced-motion preference is read at that moment (a one-shot entrance
 * has no later frames to stop), the duration comes from motion tokens, and
 * the resting styles never depend on the animation having run.
 */
function useEntranceAnimation(
  ref: React.RefObject<HTMLElement | null>,
  variant: ToolApprovalVariant,
  resolution: ToolApprovalResolution | null | undefined,
  // Shared with the exit hook, which retires ONLY this animation — never
  // host-owned players or transitions on the same node.
  animationRef: React.RefObject<Animation | null>,
) {
  const mountVariant = React.useRef(variant)
  // A card mounted already-resolved (a restored transcript, say) never plays
  // an entrance; only the mount-time state matters here.
  const mountResolved = React.useRef(resolution != null)
  React.useEffect(() => {
    const node = ref.current
    if (!node || mountResolved.current) return
    if (window.matchMedia(reducedMotionQuery).matches) return
    const entrance = entranceByVariant[mountVariant.current]
    const styles = getComputedStyle(node)
    const duration = cssDurationInMilliseconds(
      styles.getPropertyValue(entrance.durationToken),
      entrance.fallback,
    )
    if (duration === 0) return
    const easing =
      styles.getPropertyValue("--nessa-motion-easing-standard").trim() ||
      "ease-out"
    const animation = node.animate(entrance.keyframes, { duration, easing })
    animationRef.current = animation
    return () => {
      animation.cancel()
      if (animationRef.current === animation) animationRef.current = null
    }
  }, [animationRef, ref])
}

/**
 * Plays the exit when the card TRANSITIONS from pending to resolved, holding
 * the final frame until the host unmounts, then reports completion through
 * `onExited` — exactly once per resolution. Under reduced motion (or a
 * zeroed duration token) the report is immediate. A card mounted
 * already-resolved is static history: no exit plays and nothing is
 * reported. Clearing the resolution cancels a running exit (the card
 * returns) and re-arms the report. The exit keeps the variant AND the
 * resolution it started with: neither a responsive variant flip nor a
 * mid-exit allowed→denied change restarts or replays the motion. Returns
 * whether the card is currently exiting — resolved by a live transition
 * rather than mounted that way.
 */
function useResolutionExit(
  ref: React.RefObject<HTMLElement | null>,
  variant: ToolApprovalVariant,
  resolution: ToolApprovalResolution | null | undefined,
  onExited: (() => void) | undefined,
  entranceRef: React.RefObject<Animation | null>,
) {
  const onExitedRef = React.useRef(onExited)
  const variantRef = React.useRef(variant)
  // Synced in an effect, not during render: an abandoned concurrent render
  // (a discarded transition) must never arm the exit with a variant or
  // callback that was never committed. Declared before the exit effect so
  // the sync lands first within each commit.
  React.useEffect(() => {
    onExitedRef.current = onExited
    variantRef.current = variant
  })
  const mountedResolved = React.useRef(resolution != null)
  const reported = React.useRef(false)
  // True once the card is resolved with no motion to play (reduced motion,
  // or zeroed duration tokens). The exit's END STATE still applies — just
  // instantly — so the card never sits fully visible while inert.
  const [motionless, setMotionless] = React.useState(false)
  // Keyed on resolved-ness, not the resolution's value: an optimistic
  // allowed that flips to denied mid-exit must not cancel-and-restart the
  // motion (a cancel drops the fill and flashes the card back first).
  const resolved = resolution != null
  React.useEffect(() => {
    if (!resolved) {
      // Back to pending: the next resolution is a real transition again.
      mountedResolved.current = false
      reported.current = false
      setMotionless(false)
      return
    }
    if (mountedResolved.current || reported.current) return
    const node = ref.current
    if (!node) return
    const report = () => {
      if (reported.current) return
      reported.current = true
      onExitedRef.current?.()
    }
    if (window.matchMedia(reducedMotionQuery).matches) {
      setMotionless(true)
      report()
      return
    }
    const exit = exitByVariant[variantRef.current]
    const styles = getComputedStyle(node)
    const duration = cssDurationInMilliseconds(
      styles.getPropertyValue(exit.durationToken),
      exit.fallback,
    )
    if (duration === 0) {
      setMotionless(true)
      report()
      return
    }
    const easing =
      styles.getPropertyValue("--nessa-motion-easing-standard").trim() ||
      "ease-out"
    // Depart from wherever the card actually is — a resolution landing
    // mid-entrance samples the in-flight values, then retires the entrance
    // (and only the entrance: host-owned animations on the node are not
    // ours to cancel) so the two never composite against each other. The
    // from-frame carries only the properties the exit animates, leaving the
    // rest to the cascade.
    const from: Keyframe = {}
    if ("opacity" in exit.to) from.opacity = styles.opacity
    if ("translate" in exit.to) {
      from.translate = styles.translate === "none" ? "0 0" : styles.translate
    }
    entranceRef.current?.cancel()
    entranceRef.current = null
    const animation = node.animate([from, exit.to], {
      duration,
      easing,
      fill: "forwards",
    })
    let cancelled = false
    animation.finished
      .then(() => {
        if (!cancelled) report()
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      animation.cancel()
    }
  }, [entranceRef, ref, resolved])
  // Ref reads during render are safe here: the refs only change in effects,
  // and every change is paired with a state/prop change that re-renders.
  return { exiting: resolved && !mountedResolved.current, motionless }
}

/**
 * The card's resolution, provided to descendants that must react to it even
 * from outside the card's DOM subtree — the portaled scope menu closes on
 * it, since the card's `inert` cannot reach a portal.
 */
const ToolApprovalResolutionContext =
  React.createContext<ToolApprovalResolution | null>(null)

/**
 * Builds one ref callback that feeds the element to the component's own ref
 * and to a ref the consumer may have passed, so neither side loses it.
 * Memoize the result (`useMemo(..., [forwarded])`) so React never detaches
 * and reattaches refs render-to-render. A consumer callback that returns a
 * React 19 cleanup keeps its cleanup semantics.
 */
function composeRefs<Element>(
  internal: React.RefObject<Element | null>,
  forwarded: React.Ref<Element> | undefined,
): React.RefCallback<Element> {
  return (element) => {
    internal.current = element
    if (typeof forwarded === "function") {
      const cleanup = forwarded(element)
      if (typeof cleanup === "function") {
        return () => {
          internal.current = null
          cleanup()
        }
      }
    } else if (forwarded) {
      forwarded.current = element
    }
  }
}

export interface ToolApprovalProps extends React.ComponentProps<"div"> {
  /** The card's surface treatment and geometry. Defaults to `docked`. */
  variant?: ToolApprovalVariant
  /**
   * The decision, once made. Setting it makes the card inert (exposed as
   * `data-resolution` for styling) and plays the variant's exit motion —
   * docked and floating sink and fade, the notch slides back up behind its
   * edge — holding the final frame until the host unmounts the card. With
   * reduced motion the same end state applies instantly, so an inert card
   * never lingers looking live.
   */
  resolution?: ToolApprovalResolution | null
  /**
   * Called once the exit motion finishes (immediately under reduced motion),
   * at most once per resolution. Pair it with `resolution`: unmount the card
   * here, show what follows — a running tool row, a denied note — and
   * re-home focus (the composer input, typically), since the exiting card
   * went inert and released it. Without it a resolved card simply stays at
   * its exit frame, inert. A card mounted already-resolved never exits and
   * never calls this.
   */
  onExited?: () => void
}

/**
 * A tool-permission request card: an agent wants to run something and the
 * person decides. Compose a ToolApprovalHeader (icon and a heading stack of
 * title plus description), an optional ToolApprovalCommand payload, and a
 * ToolApprovalActions row of ToolApprovalAction buttons. The same content
 * renders docked above a composer, as a compact floating panel, or dropping
 * from a display notch — only `variant` changes. The card is announced as a
 * group named by its accessible label, and it plays a token-driven entrance
 * on mount.
 */
function ToolApproval({
  variant = "docked",
  resolution,
  onExited,
  className,
  children,
  ref: hostRef,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: ToolApprovalProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const entranceAnimationRef = React.useRef<Animation | null>(null)
  useEntranceAnimation(ref, variant, resolution, entranceAnimationRef)
  const { exiting, motionless } = useResolutionExit(
    ref,
    variant,
    resolution,
    onExited,
    entranceAnimationRef,
  )
  const composedRef = React.useMemo(() => composeRefs(ref, hostRef), [hostRef])
  return (
    <div
      ref={composedRef}
      role="group"
      aria-label={
        ariaLabel ?? (ariaLabelledBy ? undefined : "Tool approval request")
      }
      aria-labelledby={ariaLabelledBy}
      data-slot="tool-approval"
      data-variant={variant}
      data-resolution={resolution ?? undefined}
      // An EXITING card is done taking input: inert removes the subtree from
      // pointer, keyboard, and the accessibility tree — an exit frame held
      // at opacity 0 must not keep focusable, announced buttons behind it.
      // A card mounted already-resolved is visible history and stays fully
      // readable by assistive tech; hosts render such history without live
      // action buttons.
      inert={exiting || undefined}
      className={cn(
        "group/tool-approval relative flex min-w-0 flex-col gap-3 border border-border bg-card font-sans text-card-foreground",
        exiting && "pointer-events-none",
        // With motion off there is no player to hold the exit's last frame,
        // so the same end state applies instantly — an inert card must
        // never read as a live, actionable one.
        motionless && (variant === "notch" ? "-translate-y-full" : "opacity-0"),
        variant === "docked" && "w-full rounded-2xl p-3 shadow-sm",
        variant === "floating" &&
          "w-[min(24rem,100%)] rounded-2xl p-4 shadow-lg",
        variant === "notch" &&
          "w-[min(28rem,100%)] rounded-b-3xl border-t-0 px-4 pb-4 pt-3 shadow-lg",
        className,
      )}
      {...props}
    >
      <ToolApprovalResolutionContext.Provider value={resolution ?? null}>
        {children}
      </ToolApprovalResolutionContext.Provider>
    </div>
  )
}

export interface ToolApprovalHeaderProps extends React.ComponentProps<"div"> {}

/**
 * The card's identity row: a ToolApprovalIcon leading a ToolApprovalHeading
 * that stacks the title and description. Trailing children (a badge, say)
 * simply join the row; without an icon the heading owns the full width.
 */
function ToolApprovalHeader({ className, ...props }: ToolApprovalHeaderProps) {
  return (
    <div
      data-slot="tool-approval-header"
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5",
        className,
      )}
      {...props}
    />
  )
}

export interface ToolApprovalIconProps extends React.ComponentProps<"span"> {}

/**
 * The tool's glyph in a small muted tile. Pass the bare icon element; the
 * tile owns sizing and color.
 */
function ToolApprovalIcon({
  className,
  children,
  ...props
}: ToolApprovalIconProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="tool-approval-icon"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}

export interface ToolApprovalHeadingProps extends React.ComponentProps<"div"> {}

/** Stacks the ToolApprovalTitle over its ToolApprovalDescription. */
function ToolApprovalHeading({
  className,
  ...props
}: ToolApprovalHeadingProps) {
  return (
    <div
      data-slot="tool-approval-heading"
      className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

export interface ToolApprovalTitleProps extends React.ComponentProps<"div"> {}

/** The request in one line, e.g. "Run command" or "Edit config.toml". */
function ToolApprovalTitle({ className, ...props }: ToolApprovalTitleProps) {
  return (
    <div
      data-slot="tool-approval-title"
      className={cn(
        "nessa-text-4 font-medium text-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface ToolApprovalDescriptionProps
  extends React.ComponentProps<"div"> {}

/** Muted supporting detail under the title — who is asking, and to do what. */
function ToolApprovalDescription({
  className,
  ...props
}: ToolApprovalDescriptionProps) {
  return (
    <div
      data-slot="tool-approval-description"
      className={cn("nessa-text-4 text-muted-foreground", className)}
      {...props}
    />
  )
}

export interface ToolApprovalCommandProps
  extends React.ComponentProps<"div"> {
  /**
   * A structured payload — a tool call's input object, or a JSON string
   * (parsed first, falling back to the raw text). Structured values render
   * through JsonTree with muted key tinting so the person can actually read
   * what the tool is about to receive. Takes precedence over children.
   */
  json?: unknown
  /**
   * With `json`, adds JsonTree's fold toggles to objects and arrays. Off by
   * default: an approval surface usually owes the person the whole payload.
   */
  jsonCollapsible?: boolean
  /** Accessible name for the payload region. Defaults to "Command input". */
  label?: string
}

/** Returns a JSON string's parsed value, or the raw text when it isn't JSON. */
function parseJsonPayload(json: unknown): unknown {
  if (typeof json !== "string") return json
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

/**
 * The exact payload being approved — a shell command, a file path, a tool
 * call's input — as wrapped monospace text on the same muted panel treatment
 * as tool-call payloads. Lines always wrap; past the built-in height cap the
 * region scrolls instead of stretching the card, gaining a tab stop and an
 * inset focus outline only while it actually overflows. Pass `json` for
 * structured inputs, rendered through JsonTree (fold toggles opt in via
 * `jsonCollapsible`). For richer payloads (a diff, say), compose ToolCallDiff
 * or any other surface directly in the card instead.
 */
function ToolApprovalCommand({
  json,
  jsonCollapsible = false,
  label,
  className,
  children,
  ref: hostRef,
  ...props
}: ToolApprovalCommandProps) {
  const ref = React.useRef<HTMLElement>(null)
  const composedRef = React.useMemo(
    () => composeRefs(ref, hostRef as React.Ref<HTMLElement> | undefined),
    [hostRef],
  )
  // Scroll regions must be keyboard-reachable, but a tab stop is only owed
  // while the payload actually overflows the height cap.
  const [scrollable, setScrollable] = React.useState(false)
  const updateScrollable = React.useCallback(() => {
    const element = ref.current
    if (!element) return
    // The 1px tolerance keeps fractional content heights from minting a
    // phantom tab stop on a payload that cannot actually scroll.
    setScrollable(element.scrollHeight - element.clientHeight > 1)
  }, [])
  // Hosts swap payloads without remounting, so overflow is re-measured after
  // every commit; the observer covers non-React resizes.
  React.useEffect(() => {
    updateScrollable()
  })
  React.useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(updateScrollable)
    observer.observe(element)
    return () => observer.disconnect()
  }, [updateScrollable])
  const structured = React.useMemo(
    () => (json === undefined ? undefined : parseJsonPayload(json)),
    [json],
  )
  // JsonTree fold state is per-node and uncontrolled; a payload with NEW
  // content must render fresh, never inheriting folds the person made on the
  // previous request — on a consent surface that would hide unreviewed
  // content. The key is the serialized content, not the object identity, so
  // hosts passing a fresh-but-equal object every render don't remount the
  // tree (which would drop fold state, selection, and scroll mid-read).
  // Payloads that cannot serialize (circular, bigint) key by identity via a
  // per-object id instead — distinct unserializable payloads must never
  // share a key and silently inherit each other's folds.
  const unserializableIds = React.useRef({
    ids: new WeakMap<object | ((...args: never[]) => unknown), number>(),
    next: 0,
  })
  const jsonContentKey = React.useMemo(() => {
    if (json === undefined) return undefined
    const identityKey = () => {
      // Objects and functions can be WeakMap keys; anything else (a bigint,
      // say) keys by its own text. The two branches carry distinct prefixes
      // so a literal's text can never collide with a reference's id.
      // null goes down the literal branch as well; it never actually
      // reaches here (JSON.stringify(null) succeeds), but typeof null is
      // "object", so this is what narrows it away from the WeakMap.
      if (
        json === null ||
        (typeof json !== "object" && typeof json !== "function")
      ) {
        return `unserializable-literal-${String(json)}`
      }
      const store = unserializableIds.current
      let id = store.ids.get(json)
      if (id === undefined) {
        id = ++store.next
        store.ids.set(json, id)
      }
      return `unserializable-ref-${id}`
    }
    try {
      return JSON.stringify(structured) ?? identityKey()
    } catch {
      return identityKey()
    }
  }, [json, structured])
  // leading-5 deliberately loosens level 2's ratio for scannable mono JSON.
  const regionClassName = cn(
    "max-h-48 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono nessa-text-2 leading-5 text-foreground outline-none focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
    className,
  )
  const regionProps = {
    "data-slot": "tool-approval-command",
    role: "region",
    "aria-label": label ?? "Command input",
    tabIndex: scrollable ? 0 : undefined,
    className: regionClassName,
  } as const
  // Structured values render as JsonTree rows, which are flow content — so
  // the region is a div there and a pre for plain text.
  if (json !== undefined && typeof structured !== "string") {
    return (
      <div ref={composedRef} {...regionProps} {...props}>
        <JsonTree
          key={jsonContentKey}
          value={structured}
          collapsible={jsonCollapsible}
        />
      </div>
    )
  }
  return (
    <pre
      ref={composedRef}
      {...regionProps}
      {...(props as React.ComponentProps<"pre">)}
    >
      {typeof structured === "string" ? structured : children}
    </pre>
  )
}

export interface ToolApprovalActionsProps extends React.ComponentProps<"div"> {}

/**
 * The decision row. Actions lead from the end so the primary choice sits at
 * the reading edge; on narrow surfaces the row wraps. Hosts stacking buttons
 * full-width (a mobile sheet, say) restyle via className.
 */
function ToolApprovalActions({
  className,
  ...props
}: ToolApprovalActionsProps) {
  return (
    <div
      data-slot="tool-approval-actions"
      className={cn(
        "flex w-full min-w-0 flex-wrap items-center justify-end gap-2",
        className,
      )}
      {...props}
    />
  )
}

export interface ToolApprovalActionProps extends ButtonProps {}

/**
 * One decision button — Nessa's Button at the small size, nothing custom.
 * Choose variants by weight: `default` for the primary allow, `secondary`
 * or `outline` for softer grants, `ghost` for deny/dismiss. Every action in
 * a row keeps the same geometry, so no one choice reads as heavier than the
 * others by size alone; weight is carried by variant.
 */
function ToolApprovalAction({
  size = "sm",
  variant = "outline",
  asChild = false,
  className,
  children,
  ...props
}: ToolApprovalActionProps) {
  return (
    <Button
      data-slot="tool-approval-action"
      asChild={asChild}
      {...(asChild ? {} : { type: "button" as const })}
      size={size}
      variant={variant}
      className={className}
      {...props}
    >
      {children}
    </Button>
  )
}

export interface ToolApprovalActionMenuProps
  extends Omit<ButtonProps, "asChild"> {
  /** The trigger's label, e.g. "Always allow". */
  label: React.ReactNode
  /** Optional muted heading rendered above the choices, e.g. "Apply to". */
  menuLabel?: React.ReactNode
  /** Extra classes for the dropdown surface. */
  contentClassName?: string
  /** The scope choices, as ToolApprovalActionMenuItem elements. */
  children: React.ReactNode
}

/**
 * A decision that needs a scope: the trigger looks like any other
 * ToolApprovalAction, and pressing it opens a small menu of
 * ToolApprovalActionMenuItem choices — the canonical use is "Always allow"
 * fanning out into always versus this-session, each with a description that
 * makes the reach of the grant explicit before it is given.
 */
function ToolApprovalActionMenu({
  label,
  menuLabel,
  contentClassName,
  size = "sm",
  variant = "outline",
  className,
  children,
  ...props
}: ToolApprovalActionMenuProps) {
  const resolution = React.useContext(ToolApprovalResolutionContext)
  const [open, setOpen] = React.useState(false)
  // Radix never reports the force-close below through onOpenChange, so sync
  // the local state ourselves — otherwise a later host reset back to
  // pending would pop the menu open with no user gesture.
  React.useEffect(() => {
    if (resolution != null) setOpen(false)
  }, [resolution])
  return (
    // The content portals to the body, beyond the resolved card's inert
    // subtree — so the menu force-closes the moment a resolution lands,
    // before a stale scope choice can grant anything.
    <DropdownMenu.Root
      open={resolution == null && open}
      onOpenChange={setOpen}
    >
      <DropdownMenu.Trigger asChild>
        <Button
          data-slot="tool-approval-action-menu-trigger"
          type="button"
          size={size}
          variant={variant}
          className={className}
          {...props}
        >
          {label}
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-slot="tool-approval-action-menu-content"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "z-50 min-w-48 rounded-xl border border-border bg-popover p-1 font-sans text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            contentClassName,
          )}
        >
          {menuLabel != null && (
            <DropdownMenu.Label className="px-2 py-1.5 nessa-text-2 font-medium text-muted-foreground">
              {menuLabel}
            </DropdownMenu.Label>
          )}
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export interface ToolApprovalActionMenuItemProps
  extends React.ComponentProps<typeof DropdownMenu.Item> {
  /**
   * Muted second line spelling out the grant's reach, e.g. "Resets when
   * this session ends". Scope is exactly what must be unmistakable here, so
   * omit it only when the label alone already is.
   */
  description?: React.ReactNode
}

/** One scope choice in a ToolApprovalActionMenu; `onSelect` receives it. */
function ToolApprovalActionMenuItem({
  description,
  className,
  children,
  ...props
}: ToolApprovalActionMenuItemProps) {
  const descriptionId = React.useId()
  return (
    <DropdownMenu.Item
      data-slot="tool-approval-action-menu-item"
      aria-describedby={description != null ? descriptionId : undefined}
      className={cn(
        "flex min-h-9 cursor-default select-none flex-col items-start justify-center gap-0.5 rounded-lg px-2 py-1.5 nessa-text-4 text-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] data-[highlighted]:bg-accent focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      {children}
      {description != null && (
        // aria-hidden keeps the scope text out of the item's accessible
        // NAME; the aria-describedby reference still surfaces it to AT as a
        // proper description.
        <span
          id={descriptionId}
          aria-hidden="true"
          data-slot="tool-approval-action-menu-item-description"
          className="nessa-text-2 text-muted-foreground"
        >
          {description}
        </span>
      )}
    </DropdownMenu.Item>
  )
}

export {
  ToolApproval,
  ToolApprovalAction,
  ToolApprovalActionMenu,
  ToolApprovalActionMenuItem,
  ToolApprovalActions,
  ToolApprovalCommand,
  ToolApprovalDescription,
  ToolApprovalHeader,
  ToolApprovalHeading,
  ToolApprovalIcon,
  ToolApprovalTitle,
}
