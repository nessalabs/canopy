import * as React from "react"

import { cn } from "@/lib/utils"

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

function subscribeToReducedMotion(callback: () => void) {
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}

/** Returns the live, server-safe reduced-motion preference. */
function useReducedMotion() {
  return React.useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  )
}

/**
 * How long the completion announcement stays in the live region before it
 * is cleared. Long enough for assistive tech to pick up the mutation,
 * short enough that a settled page carries no stale status text.
 */
const ANNOUNCEMENT_LINGER = 5000

/** Parses a CSS duration token value into milliseconds. */
function cssDurationInMilliseconds(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return value.trim().endsWith("ms") ? parsed : parsed * 1000
}

/**
 * The shimmer sweep and the smoke plumes are painted with theme tokens —
 * muted-foreground body, foreground crest — so they read in both schemes
 * without `dark:` variants.
 */
const generatingLabelShimmerClasses =
  "data-[shimmer=true]:[background-image:linear-gradient(90deg,var(--muted-foreground)_0%,var(--muted-foreground)_38%,var(--foreground)_50%,var(--muted-foreground)_62%,var(--muted-foreground)_100%)] data-[shimmer=true]:bg-[length:200%_100%] data-[shimmer=true]:bg-[position:150%_0] data-[shimmer=true]:bg-clip-text data-[shimmer=true]:[-webkit-background-clip:text] data-[shimmer=true]:text-transparent"

const generatingPlumeGradientClass =
  "[background:radial-gradient(closest-side,var(--foreground),transparent)]"

/**
 * Where each smoke plume sits and how it drifts. Sizes are fractions of the
 * placeholder so the effect scales with whatever the host reserves; the
 * drift keyframes are percentages of each plume's own size, kept small so
 * the motion stays ambient rather than attention-seeking.
 */
const generatingPlumes = [
  {
    className: "left-[4%] top-[10%] h-[85%] w-[42%]",
    drift: [
      { transform: "translate(-12%, 8%) scale(0.9)" },
      { transform: "translate(16%, -10%) scale(1.15)" },
    ],
  },
  {
    className: "left-[30%] top-[-15%] h-[95%] w-[48%]",
    drift: [
      { transform: "translate(10%, -6%) scale(1.1)" },
      { transform: "translate(-14%, 12%) scale(0.85)" },
    ],
  },
  {
    className: "right-[2%] top-[25%] h-[80%] w-[40%]",
    drift: [
      { transform: "translate(8%, 12%) scale(0.95)" },
      { transform: "translate(-10%, -8%) scale(1.2)" },
    ],
  },
] as const

/**
 * The ambient layer inside the placeholder: soft token-tinted plumes that
 * drift and breathe on de-phased alternating cycles, reading as smoke
 * curling behind the label. Purely decorative — hidden from the a11y tree,
 * and static (still visible, just motionless) under reduced motion.
 */
function GeneratingSurfaceSmoke() {
  const reducedMotion = useReducedMotion()
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const node = ref.current
    if (!node || reducedMotion) return
    const duration = cssDurationInMilliseconds(
      getComputedStyle(node).getPropertyValue("--nessa-motion-duration-ambient"),
      3200,
    )
    if (duration === 0) return
    // Each plume gets a different period and a negative delay, so the three
    // cycles never phase-lock into one synchronized pulse.
    const animations = Array.from(node.children, (child, index) =>
      (child as HTMLElement).animate([...generatingPlumes[index]!.drift], {
        duration: duration * (1.6 + index * 0.7),
        delay: -index * duration,
        easing: "ease-in-out",
        direction: "alternate",
        iterations: Infinity,
        fill: "both",
      }),
    )
    return () => animations.forEach((animation) => animation.cancel())
  }, [reducedMotion])
  return (
    <div ref={ref} aria-hidden="true" className="absolute inset-0">
      {generatingPlumes.map((plume) => (
        // The first keyframe is also the inline transform: the drift is
        // attached in an effect, which runs after paint, so without it the
        // plumes would paint one untransformed frame and then snap.
        <div
          key={plume.className}
          className={cn("absolute rounded-full opacity-[0.07] blur-2xl", generatingPlumeGradientClass, plume.className)}
          style={{
            transform: plume.drift[0].transform,
          }}
        />
      ))}
    </div>
  )
}

/**
 * The status label centered in the placeholder, sweeping the same
 * glyph-clipped highlight as ToolCall's running shimmer. The gradient is
 * clipped to the text so the label stays real, announceable text; under
 * reduced motion it renders as plain muted text.
 */
function GeneratingSurfaceLabel({ children }: { children: React.ReactNode }) {
  const reducedMotion = useReducedMotion()
  const ref = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    const node = ref.current
    if (!node || reducedMotion) return
    const duration = cssDurationInMilliseconds(
      getComputedStyle(node).getPropertyValue("--nessa-motion-duration-ambient"),
      3200,
    )
    if (duration === 0) return
    // The highlight sits at the center of a double-width background, so
    // sliding the position from 150% to -50% carries it once across the
    // text per cycle, left to right.
    const animation = node.animate(
      [{ backgroundPosition: "150% 0" }, { backgroundPosition: "-50% 0" }],
      { duration, easing: "linear", iterations: Infinity },
    )
    return () => animation.cancel()
  }, [reducedMotion])
  return (
    <span
      ref={ref}
      data-slot="generating-surface-label"
      data-shimmer={reducedMotion ? undefined : "true"}
      className={cn("relative nessa-text-4 text-muted-foreground", generatingLabelShimmerClasses)}
    >
      {children}
    </span>
  )
}

/**
 * `generating` shows the placeholder, `revealing` runs the one-shot morph
 * from placeholder to content, `settled` is plain content with no wrappers
 * left animating.
 */
type GeneratingSurfacePhase = "generating" | "revealing" | "settled"

export interface GeneratingSurfaceProps extends React.ComponentProps<"div"> {
  /**
   * While true, the ambient placeholder shows instead of the children; when
   * it flips false, the placeholder morphs into the children — the surface
   * resizes from the reserved height to the content's height, then the
   * smoke fades through into the content as it sharpens in from a soft blur.
   */
  generating: boolean
  /**
   * The status text shimmering in the placeholder, announced politely to
   * assistive technology. Defaults to "Generating".
   */
  label?: string
  /**
   * Extra classes for the placeholder panel — most usefully a `min-h-*`
   * override when the host knows roughly how tall the finished content
   * will be, which shortens the height morph on reveal.
   */
  placeholderClassName?: string
  /**
   * The polite announcement when a reveal settles, closing the loop for
   * screen-reader users who heard `label`. Defaults to "Finished
   * generating". Never announced for a surface that mounted already
   * settled.
   */
  settledLabel?: string
  /**
   * Called each time the surface settles after having generated — the
   * reveal morph finished (or was skipped for reduced motion) and the
   * placeholder is gone. Not called for a surface that mounted already
   * settled. Hosts use it to hold back chrome that should not be reachable
   * while the content is still covered, like MermaidDiagram's expand
   * control.
   */
  onSettled?: () => void
  /** The finished content. Rendered once `generating` is false. */
  children?: React.ReactNode
}

/**
 * A container for content that takes a while to generate — diagrams,
 * images, previews, anything an assistant streams or renders. While
 * `generating` it reserves space with an ambient placeholder (drifting
 * smoke and a shimmering status label instead of half-finished output);
 * when `generating` flips off, the placeholder morphs into the content in
 * two beats, like a container transform: the surface first resizes to the
 * content's height with the placeholder still opaque, then fades through —
 * the smoke dissolves fully and the content sharpens in from a soft blur — so
 * the finished artifact lands without a layout jump or a ghosted
 * double-exposure.
 * Mounted with `generating` already false it renders the children plainly,
 * and under reduced motion the reveal applies its end state instantly.
 */
function GeneratingSurface({
  generating,
  label = "Generating",
  settledLabel = "Finished generating",
  placeholderClassName,
  onSettled,
  className,
  children,
  ...props
}: GeneratingSurfaceProps) {
  const reducedMotion = useReducedMotion()
  const [phase, setPhase] = React.useState<GeneratingSurfacePhase>(
    generating ? "generating" : "settled",
  )
  // Whether this surface ever generated: a surface mounted already settled
  // announces nothing and never calls onSettled.
  const [hasGenerated, setHasGenerated] = React.useState(generating)
  // The phase follows `generating` during render, not from an effect: an
  // effect runs after paint, which would leave one frame showing settled
  // content — and, for hosts that gate chrome on onSettled, a stale
  // control — after a new generation pass had already begun.
  const [lastGenerating, setLastGenerating] = React.useState(generating)
  if (lastGenerating !== generating) {
    setLastGenerating(generating)
    if (generating) {
      setHasGenerated(true)
      setPhase("generating")
    } else if (phase === "generating") {
      setPhase("revealing")
    }
  }
  const onSettledRef = React.useRef(onSettled)
  React.useEffect(() => {
    onSettledRef.current = onSettled
  })
  // A live region only announces mutations made after it joins the
  // accessibility tree, so the status text is injected post-mount from an
  // effect rather than rendered with the region.
  const [announced, setAnnounced] = React.useState("")
  React.useEffect(() => {
    if (!hasGenerated) return
    if (phase !== "settled") {
      setAnnounced(label)
      return
    }
    // Completion is an event, not a state: announce it, then clear it, so
    // a finished transcript is not littered with invisible "finished"
    // strings for anyone browsing it afterwards.
    setAnnounced(settledLabel)
    const timer = window.setTimeout(() => setAnnounced(""), ANNOUNCEMENT_LINGER)
    return () => window.clearTimeout(timer)
  }, [phase, hasGenerated, label, settledLabel])
  React.useEffect(() => {
    if (phase === "settled" && hasGenerated) onSettledRef.current?.()
  }, [phase, hasGenerated])
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const placeholderRef = React.useRef<HTMLDivElement>(null)
  // The placeholder's height is captured on every generating-phase render
  // so the reveal can start its height morph from the box the user last
  // saw, even though the placeholder has left the flow by then.
  const placeholderHeight = React.useRef(0)

  React.useLayoutEffect(() => {
    if (phase === "generating" && placeholderRef.current) {
      placeholderHeight.current = placeholderRef.current.offsetHeight
    }
  })

  React.useLayoutEffect(() => {
    if (phase !== "revealing") return
    const surface = surfaceRef.current
    const content = contentRef.current
    const placeholder = placeholderRef.current
    if (!surface || !content) {
      setPhase("settled")
      return
    }
    const style = getComputedStyle(surface)
    const duration = cssDurationInMilliseconds(
      style.getPropertyValue("--nessa-motion-duration-slow"),
      300,
    )
    // Reduced motion means "apply the end state instantly", and a zeroed
    // duration token means the same thing.
    if (reducedMotion || duration === 0) {
      setPhase("settled")
      return
    }
    const easing =
      style.getPropertyValue("--nessa-motion-easing-standard").trim() ||
      "cubic-bezier(0.2, 0, 0, 1)"
    const fadeDuration = cssDurationInMilliseconds(
      style.getPropertyValue("--nessa-motion-duration-fast"),
      120,
    )
    // The reveal is sequenced like a container transform, not a single long
    // cross-dissolve — a simultaneous fade would double-expose the content
    // through the still-covering placeholder as a muddy ghost. First the
    // surface resizes to the content's height with the placeholder fully
    // opaque on top (the content is in flow, so the surface's natural height
    // is already the destination); then a quick fade-through: the smoke
    // fades out completely and only then does the content sharpen in from a
    // soft blur, with just enough overlap that the swap reads as one
    // motion — the defocus-to-focus resolve is the intended feel (owner
    // preference) even though the blur layer re-rasterizes hairline SVG
    // strokes as it animates away.
    const animations = [
      surface.animate(
        [
          { height: `${placeholderHeight.current}px` },
          { height: `${surface.offsetHeight}px` },
        ],
        { duration, easing },
      ),
      content.animate(
        [
          { opacity: 0, filter: "blur(6px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        {
          duration,
          delay: duration + fadeDuration / 2,
          easing: "ease-out",
          fill: "backwards",
        },
      ),
    ]
    if (placeholder) {
      animations.push(
        placeholder.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: fadeDuration,
          delay: duration,
          easing: "ease-out",
          fill: "both",
        }),
      )
    }
    let cancelled = false
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(
      () => {
        if (!cancelled) setPhase("settled")
      },
    )
    // The height keyframes above describe the content as it was when the
    // morph began. A host that swaps in different children mid-morph (a
    // live editor re-rendering while the first reveal is still running)
    // invalidates them: the surface would animate toward — and, being
    // overflow-hidden, clip to — a height that no longer belongs to what is
    // on screen, then snap when the animation drops off. Finishing early is
    // the honest response; the content is what the reader wants, not the
    // flourish. The threshold ignores sub-pixel and scrollbar-sized noise
    // so an ordinary reveal is never cut short by its own layout.
    let baseHeight = content.offsetHeight
    let baseWidth = content.offsetWidth
    const resizeObserver = new ResizeObserver(() => {
      const { offsetHeight, offsetWidth } = content
      if (offsetWidth !== baseWidth) {
        // The container reflowed around us rather than the content
        // changing — a document scrollbar appearing as the growing surface
        // pushes the page past the viewport, or a window resize. Width-led
        // height changes are not a new artifact, and treating them as one
        // would let the reveal cancel itself through its own side effect,
        // so re-baseline and keep morphing.
        baseWidth = offsetWidth
        baseHeight = offsetHeight
        return
      }
      if (Math.abs(offsetHeight - baseHeight) > 2) {
        setPhase("settled")
      }
    })
    resizeObserver.observe(content)
    return () => {
      cancelled = true
      resizeObserver.disconnect()
      animations.forEach((animation) => animation.cancel())
    }
  }, [phase, reducedMotion])

  return (
    <div
      ref={surfaceRef}
      data-slot="generating-surface"
      data-phase={phase}
      // Busy for the whole reveal, not just the wait: through the morph the
      // content is still covered by an opaque placeholder.
      aria-busy={phase !== "settled" || undefined}
      className={cn(
        "relative min-w-0 max-w-full",
        phase === "revealing" && "overflow-hidden",
        className,
      )}
      {...props}
    >
      {phase !== "generating" && (
        // Inert through the reveal: the content is mounted but still
        // invisible under the placeholder, and the placeholder is
        // pointer-events-none, so without this a click or a Tab lands on a
        // target nobody can see — a Mermaid diagram's click directives are
        // real links.
        <div
          ref={contentRef}
          inert={phase === "revealing"}
          data-slot="generating-surface-content"
          className="min-w-0 max-w-full"
        >
          {children}
        </div>
      )}
      {phase !== "settled" && (
        // The visible placeholder is presentation only — the status region
        // below carries its meaning — and hiding it wholesale also keeps the
        // revealing-phase overlay from doubling the content in the a11y
        // tree. The phase reset comes after placeholderClassName so a host's
        // min-h-* override cannot outrank it while the overlay tracks the
        // morphing surface.
        <div
          ref={placeholderRef}
          aria-hidden="true"
          data-slot="generating-surface-placeholder"
          className={cn(
            "pointer-events-none relative flex min-h-28 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/40",
            placeholderClassName,
            phase === "revealing" && "absolute inset-0 min-h-0",
          )}
        >
          <GeneratingSurfaceSmoke />
          <span className="relative">
            <GeneratingSurfaceLabel>{label}</GeneratingSurfaceLabel>
          </span>
        </div>
      )}
      <span role="status" className="sr-only">
        {announced}
      </span>
    </div>
  )
}

export { GeneratingSurface }
