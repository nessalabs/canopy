"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { Collapsible } from "radix-ui"

import { cn } from "@/lib/utils"

/** Matches the reduced-motion media query used across Nessa motion surfaces. */
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

/** Parses a CSS duration token value into milliseconds. */
function cssDurationInMilliseconds(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return value.trim().endsWith("ms") ? parsed : parsed * 1000
}

/**
 * The moving highlight is painted with theme tokens — muted-foreground body,
 * foreground crest — so it reads in both schemes without `dark:` variants. It
 * is the same wash ToolCall and GeneratingSurface use, because it carries the
 * same meaning: this is happening now.
 */
const transcriptDividerShimmerClasses =
  "data-[shimmer=true]:[background-image:linear-gradient(90deg,var(--muted-foreground)_0%,var(--muted-foreground)_38%,var(--foreground)_50%,var(--muted-foreground)_62%,var(--muted-foreground)_100%)] data-[shimmer=true]:bg-[length:200%_100%] data-[shimmer=true]:bg-[position:150%_0] data-[shimmer=true]:bg-clip-text data-[shimmer=true]:[-webkit-background-clip:text] data-[shimmer=true]:text-transparent"

/** The hairline either side of the label. Decoration, so never announced. */
function TranscriptDividerRule() {
  return <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
}

/**
 * The label itself, shimmering while the thing it marks is still happening.
 */
function TranscriptDividerLabel({
  pending,
  meta,
  children,
}: {
  pending: boolean
  meta?: React.ReactNode
  children?: React.ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const shimmering = pending && !reducedMotion
  const ref = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    const node = ref.current
    if (!node || !shimmering) return
    const duration = cssDurationInMilliseconds(
      getComputedStyle(node).getPropertyValue("--nessa-motion-duration-ambient"),
      3200,
    )
    if (duration === 0) return
    // The highlight sits at the center of a double-width background, so
    // sliding the position from 150% to -50% carries it once across the text
    // per cycle, left to right.
    const animation = node.animate(
      [{ backgroundPosition: "150% 0" }, { backgroundPosition: "-50% 0" }],
      { duration, easing: "linear", iterations: Infinity },
    )
    return () => animation.cancel()
  }, [shimmering])

  return (
    <>
      <span
        ref={ref}
        data-shimmer={shimmering ? "true" : undefined}
        className={cn("min-w-0 truncate", transcriptDividerShimmerClasses)}
      >
        {children}
      </span>
      {meta === undefined || meta === null ? null : (
        // Same ink as the label, distinguished by weight rather than by
        // fading it: a lighter muted-foreground drops under 4.5:1 on the
        // default ground, and this text carries the numbers.
        <span className="min-w-0 truncate font-normal text-muted-foreground">{meta}</span>
      )}
    </>
  )
}

export interface TranscriptDividerProps extends React.ComponentProps<"div"> {
  /**
   * The label sitting on the rule, e.g. "Context compacted" or "Today".
   * Keep it to a few words — the divider is a marker, not a message.
   */
  children?: React.ReactNode
  /** Trailing detail after the label — a token count, a time, a reason. */
  meta?: React.ReactNode
  /**
   * The thing being marked is still happening. The label shimmers and is
   * announced politely, so a divider that sits for half a minute reads as
   * working rather than stuck.
   */
  pending?: boolean
  /**
   * What the marked event produced, revealed on click — for a compaction, the
   * summary the agent will carry forward in place of the history it dropped.
   * Given one, the label becomes a disclosure; without one it stays plain
   * text, because a marker with nothing behind it should not invite a click.
   */
  detail?: React.ReactNode
  /** Opens the detail on first render. */
  defaultExpanded?: boolean
}

/**
 * A hairline rule across a transcript with a label on it, marking a point in
 * time rather than a piece of content: a day boundary, an unread mark, a model
 * swap, a context compaction.
 *
 * It is deliberately not a card. What it marks is something that *happened to*
 * the conversation, not a step the agent took, and giving it a card's weight
 * would put it in competition with the work either side of it. Anything the
 * event produced hides behind `detail` rather than sitting in the transcript,
 * so the marker stays one line until a reader asks for more.
 */
function TranscriptDivider({
  className,
  children,
  meta,
  pending = false,
  detail,
  defaultExpanded = false,
  ...props
}: TranscriptDividerProps) {
  const rowClasses = cn("flex w-full items-center gap-3 py-1 select-none", className)

  if (detail === undefined || detail === null) {
    return (
      <div
        data-slot="transcript-divider"
        data-pending={pending ? "true" : undefined}
        className={rowClasses}
        {...props}
      >
        <TranscriptDividerRule />
        <span
          // Announced only while pending: a settled marker is part of the
          // transcript a reader can scroll to, not news.
          aria-live={pending ? "polite" : undefined}
          className="flex min-w-0 items-center gap-1.5 whitespace-nowrap nessa-text-2 font-medium text-muted-foreground"
        >
          <TranscriptDividerLabel pending={pending} meta={meta}>
            {children}
          </TranscriptDividerLabel>
        </span>
        <TranscriptDividerRule />
      </div>
    )
  }

  return (
    <Collapsible.Root
      defaultOpen={defaultExpanded}
      data-slot="transcript-divider"
      data-pending={pending ? "true" : undefined}
      className={cn("group/transcript-divider flex w-full flex-col", className)}
      {...props}
    >
      <div className={cn(rowClasses, "px-0")}>
        <TranscriptDividerRule />
        {/* Only the label is the target. The rules are decoration, and a
            full-width hit area on a hairline invites accidental clicks while
            scrolling a transcript. */}
        <Collapsible.Trigger
          className="flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1 py-0.5 nessa-text-2 font-medium text-muted-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        >
          <TranscriptDividerLabel pending={pending} meta={meta}>
            {children}
          </TranscriptDividerLabel>
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] group-data-[state=open]/transcript-divider:rotate-90 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
        <TranscriptDividerRule />
      </div>
      <Collapsible.Content
        data-slot="transcript-divider-content"
        className="min-w-0 pt-1.5 nessa-text-2 text-muted-foreground"
      >
        {detail}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

export { TranscriptDivider }
