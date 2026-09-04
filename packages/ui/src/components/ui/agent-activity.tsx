import * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The lifecycle of a collapsed activity cue: `running` while the agent is
 * still working (the label shimmers), `complete` once the run of tools
 * finished, and `error` when it failed (the label tints destructive).
 */
export type AgentActivityStatus = "running" | "complete" | "error"

const AgentActivityStatusContext =
  React.createContext<AgentActivityStatus>("complete")

export interface AgentActivityCounts {
  /** How many files the run read, searched, or edited. */
  files?: number
  /** How many search or grep calls the run made. */
  searches?: number
  /** How many other tool calls do not fit the files or searches buckets. */
  other?: number
}

/**
 * Collapses a run of tool work into one transcript line: "Explored 3 files,
 * 2 searches". Empty counts return "Explored" so a host that has not yet
 * classified the calls still has a label.
 */
function formatAgentActivitySummary(counts: AgentActivityCounts): string {
  const bits: string[] = []
  if (counts.files) {
    bits.push(`${counts.files} file${counts.files === 1 ? "" : "s"}`)
  }
  if (counts.searches) {
    bits.push(`${counts.searches} search${counts.searches === 1 ? "" : "es"}`)
  }
  if (counts.other) {
    bits.push(`${counts.other} other tool${counts.other === 1 ? "" : "s"}`)
  }
  return bits.length === 0 ? "Explored" : `Explored ${bits.join(", ")}`
}

/**
 * Formats a thinking beat as "Thought 1s". Seconds are rounded to the
 * nearest whole number so a sub-second beat still reads as "Thought 0s"
 * rather than a fraction.
 */
function formatAgentThoughtSummary(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  return `Thought ${rounded}s`
}

export interface AgentActivityProps extends React.ComponentProps<"div"> {
  /**
   * The run's lifecycle state, exposed as `data-status`. While `running`
   * the group is `aria-busy` and the trigger label shimmers; `error` tints
   * the label destructive. Defaults to `complete`.
   */
  status?: AgentActivityStatus
}

/**
 * A collapsed run of tool work in an agent transcript: one quiet cue. The
 * transcript stays a conversation; clicking the cue opens the extra-details
 * sheet with that beat's thinking and tool calls. The sheet is the host's
 * — AgentActivity owns the cue, not the overlay.
 *
 * Compose AgentActivityTrigger for a disclosing cue. A thought or live
 * line with nothing behind it should be AgentActivityCue instead. Render
 * AgentActivityContent in the extra-details sheet — it is always visible
 * and is not a collapsible region under the trigger.
 */
function AgentActivity({
  status = "complete",
  className,
  ...props
}: AgentActivityProps) {
  return (
    <AgentActivityStatusContext.Provider value={status}>
      <div
        data-slot="agent-activity"
        data-status={status}
        aria-busy={status === "running" || undefined}
        className={cn(
          "group/agent-activity flex w-full min-w-0 flex-col font-sans",
          className,
        )}
        {...props}
      />
    </AgentActivityStatusContext.Provider>
  )
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

function subscribeToReducedMotion(callback: () => void) {
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}

function useReducedMotion() {
  return React.useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  )
}

function cssDurationInMilliseconds(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return value.trim().endsWith("ms") ? parsed : parsed * 1000
}

const activityShimmerClasses =
  "data-[shimmer=true]:[background-image:linear-gradient(90deg,var(--muted-foreground)_0%,var(--muted-foreground)_38%,var(--foreground)_50%,var(--muted-foreground)_62%,var(--muted-foreground)_100%)] data-[shimmer=true]:bg-[length:200%_100%] data-[shimmer=true]:bg-[position:150%_0] data-[shimmer=true]:bg-clip-text data-[shimmer=true]:[-webkit-background-clip:text] data-[shimmer=true]:text-transparent"

function ActivityShimmer({
  active,
  children,
}: {
  active: boolean
  children: React.ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const shimmering = active && !reducedMotion
  const ref = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    const node = ref.current
    if (!node || !shimmering) return
    const duration = cssDurationInMilliseconds(
      getComputedStyle(node).getPropertyValue("--nessa-motion-duration-ambient"),
      3200,
    )
    if (duration === 0) return
    const animation = node.animate(
      [{ backgroundPosition: "150% 0" }, { backgroundPosition: "-50% 0" }],
      { duration, easing: "linear", iterations: Infinity },
    )
    return () => animation.cancel()
  }, [shimmering])
  return (
    <span
      ref={ref}
      data-slot="agent-activity-shimmer"
      data-shimmer={shimmering ? "true" : undefined}
      className={cn("min-w-0 truncate text-left", activityShimmerClasses)}
    >
      {children}
    </span>
  )
}

const cueClassName =
  "flex w-fit min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 font-sans nessa-text-2 text-muted-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none"

/** Leading mark on a cue: SVG glyphs stay 14px; RandomAvatar fills 16px. */
const cueIconClassName =
  "flex shrink-0 items-center justify-center text-(--nessa-chat-accent) [&_svg]:size-3.5 [&_[data-slot=random-avatar]]:size-4"

export type AgentActivityCueProps = {
  /**
   * The cue's lifecycle. While `running` the label shimmers. Defaults to
   * `complete`. A standalone cue that is not inside AgentActivity reads this
   * prop; a trigger inside one inherits the group's status.
   */
  status?: AgentActivityStatus
  /**
   * The leading mark — typically a RandomAvatar that is `busy` while the
   * agent is still working and still once it is not. The cue owns sizing,
   * so pass the bare element.
   */
  icon?: React.ReactNode
} & (
  | (React.ComponentProps<"span"> & {
      /**
       * Renders the cue as a control that opens details — typically the
       * extra-details sheet — with a trailing chevron. Omit when the line
       * is only a thought beat with nothing behind it.
       */
      discloses?: false
    })
  | (Omit<React.ComponentProps<"button">, "type"> & {
      discloses: true
    })
)

/**
 * A quiet transcript line for agent work that is not a message: "Thought
 * 1s", "Explored 3 files, 2 searches", "Exploring…". Renders as text so a
 * thought beat does not invite a click. Pass `discloses` when the line
 * opens that beat's thinking and tool calls in the extra-details sheet.
 * Pass `aria-expanded` and `aria-controls` when the host owns the sheet.
 */
function AgentActivityCue(props: AgentActivityCueProps) {
  const groupStatus = React.useContext(AgentActivityStatusContext)
  const status = props.status ?? groupStatus
  const content = (
    <>
      {props.icon != null ? (
        <span aria-hidden="true" className={cueIconClassName}>
          {props.icon}
        </span>
      ) : null}
      <ActivityShimmer active={status === "running"}>
        {props.children}
      </ActivityShimmer>
      {props.discloses ? (
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      ) : null}
    </>
  )
  const sharedClassName = cn(
    cueClassName,
    status === "error" && "text-destructive",
    props.discloses &&
      "min-h-6 cursor-pointer hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    props.className,
  )
  if (props.discloses) {
    const {
      status: _status,
      icon: _icon,
      discloses: _discloses,
      className: _className,
      children: _children,
      ...rest
    } = props
    return (
      <button
        type="button"
        data-slot="agent-activity-cue"
        data-status={status}
        aria-haspopup="dialog"
        className={sharedClassName}
        {...rest}
      >
        {content}
      </button>
    )
  }
  const {
    status: _status,
    icon: _icon,
    discloses: _discloses,
    className: _className,
    children: _children,
    ...rest
  } = props
  return (
    <span
      data-slot="agent-activity-cue"
      data-status={status}
      className={sharedClassName}
      {...rest}
    >
      {content}
    </span>
  )
}

export interface AgentActivityTriggerProps
  extends Omit<React.ComponentProps<"button">, "children"> {
  /**
   * The leading mark, rendered ahead of the label. Pass a RandomAvatar
   * with `busy` while the group is running so the paint floods; omit
   * `busy` (or pass false) when the run is complete.
   */
  icon?: React.ReactNode
  /** The activity text, e.g. "Explored 3 files, 2 searches". */
  children?: React.ReactNode
}

/**
 * The always-visible cue for a run of tools: identity avatar, label, and
 * a chevron that marks it as a control. Clicking opens the extra-details
 * sheet for that beat — it does not expand in the transcript. The host
 * owns the sheet; pass `aria-expanded` and `aria-controls` so the cue
 * names it. While the group is `running` the label shimmers and the
 * avatar is `busy`; when it `error`ed the label tints destructive.
 */
function AgentActivityTrigger({
  icon,
  className,
  children,
  ...props
}: AgentActivityTriggerProps) {
  const status = React.useContext(AgentActivityStatusContext)
  return (
    <button
      type="button"
      data-slot="agent-activity-trigger"
      aria-haspopup="dialog"
      className={cn(
        cueClassName,
        "min-h-6 cursor-pointer hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "group-data-[status=error]/agent-activity:text-destructive",
        className,
      )}
      {...props}
    >
      {icon != null ? (
        <span aria-hidden="true" className={cueIconClassName}>
          {icon}
        </span>
      ) : null}
      <ActivityShimmer active={status === "running"}>{children}</ActivityShimmer>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
    </button>
  )
}

export interface AgentActivityContentProps extends React.ComponentProps<"div"> {}

/**
 * The thinking and tool-call list for a cue. Place it in the extra-details
 * sheet body, not beside the trigger in the transcript — it is a layout
 * grouping, not a collapsible region.
 */
function AgentActivityContent({
  className,
  ...props
}: AgentActivityContentProps) {
  return (
    <div
      data-slot="agent-activity-content"
      className={cn(
        "flex min-w-0 flex-col items-start gap-1.5",
        className,
      )}
      {...props}
    />
  )
}

export interface AgentActivityCardProps
  extends Omit<React.ComponentProps<"button">, "children" | "title"> {
  /** The named task, e.g. "Explore chat UI components". */
  title: React.ReactNode
  /** The status line under the title, e.g. "Working · Explorer". */
  meta?: React.ReactNode
  /**
   * The leading identity. Pass a RandomAvatar (`busy` while that agent is
   * working) the same way a subagent chip does; the card sizes it to the
   * chip avatar. SVG glyphs still fit the circle.
   */
  icon?: React.ReactNode
}

/**
 * A named unit of agent work as a compact card: identity avatar, title,
 * status line, and a chevron. Use it when a beat has a name of its own —
 * a spawned explorer, a delegated run — rather than a counted summary of
 * tools. The avatar animates only while that agent is working.
 */
function AgentActivityCard({
  title,
  meta,
  icon,
  className,
  ...props
}: AgentActivityCardProps) {
  return (
    <button
      type="button"
      data-slot="agent-activity-card"
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2 text-start font-sans shadow-xs outline-none transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {icon != null ? (
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-(--nessa-chat-accent) [&_svg]:size-3.5 [&_[data-slot=random-avatar]]:size-7"
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate nessa-text-3 font-semibold text-foreground">
          {title}
        </span>
        {meta != null ? (
          <span className="block truncate nessa-text-1 text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </button>
  )
}

export {
  AgentActivity,
  AgentActivityCard,
  AgentActivityContent,
  AgentActivityCue,
  AgentActivityTrigger,
  formatAgentActivitySummary,
  formatAgentThoughtSummary,
}
