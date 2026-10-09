"use client"

import * as React from "react"
import mermaid from "mermaid"
import { Maximize2, SquareArrowOutUpRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { CopyButton, useCodeBlockConfig, type CodeBlockMode } from "./code-block"
import { useDiagramViewer } from "./diagram-viewer"
import { GeneratingSurface } from "./generating-surface"

let renderSequence = 0
/**
 * Mermaid's initialize() mutates library-global config, so concurrent
 * diagrams with different themes could read each other's settings mid-render.
 * Every initialize+render pair is chained through this queue instead.
 */
let renderQueue: Promise<unknown> = Promise.resolve()

/**
 * How long a dequeued Mermaid render may run before the diagram gives up
 * and shows its source instead. Far longer than any real render — it exists
 * only so a render that never resolves cannot pin the placeholder forever.
 */
const RENDER_TIMEOUT = 10000

/** How a host opens one diagram in a window of its own. */
interface DiagramWindowValue {
  /** Called with the Mermaid source of the diagram to open. */
  open: (chart: string) => void
}

const DiagramWindowContext = React.createContext<DiagramWindowValue | null>(
  null,
)

/**
 * Offers "open in a new window" on every diagram below it. Without this
 * provider the control is not rendered at all — a diagram has no way of
 * its own to know what a second window would even be.
 *
 * @param props - The opener and the subtree it serves.
 * @returns The subtree, with the control enabled.
 */
function DiagramWindowProvider({
  open,
  children,
}: DiagramWindowValue & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ open }), [open])

  return (
    <DiagramWindowContext.Provider value={value}>
      {children}
    </DiagramWindowContext.Provider>
  )
}

export interface MermaidDiagramProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /**
   * The Mermaid source: flowcharts, sequence diagrams, state and class
   * diagrams, gantt charts — anything Mermaid parses.
   */
  chart: string
  /**
   * Which theme renders: `system` follows the OS scheme, `light` and `dark`
   * pin one. Falls back to the nearest CodeBlockProvider's mode, so diagrams
   * follow the same app-wide setting as code blocks.
   */
  mode?: CodeBlockMode
  /**
   * While true, the generating placeholder holds the space even after the
   * source first parses, so a half-streamed diagram never reveals and then
   * reflows as more source arrives; the latest successful render is kept
   * ready behind it and morphs in when this flips false. MessageMarkdown
   * sets it automatically while a ```mermaid fence is still open. Passing
   * it once latches the instance into the streaming contract: from then on
   * a changed chart shows the placeholder until its own render lands (or
   * the raw source, if it never does) instead of keeping the previous
   * render on screen.
   */
  streaming?: boolean
  /**
   * Open the viewer as soon as the diagram has drawn, rather than waiting
   * for the expand control. A window opened to show one diagram is the
   * case this exists for.
   */
  defaultExpanded?: boolean
}

/**
 * A Mermaid diagram rendered to SVG — one component for every Mermaid
 * grammar, sequence diagrams included. While a diagram streams in, invalid
 * intermediate source keeps the last successful render on screen; until the
 * first successful parse a GeneratingSurface placeholder holds the space and
 * then morphs into the drawn diagram, so streaming never flashes raw source
 * text (the copy control still copies it). With the `streaming` prop the
 * placeholder holds until the source is final AND that final source has
 * rendered, and source that never parses settles into the muted raw text
 * instead of generating forever. The expand control
 * opens a fullscreen viewer with drag-to-pan and wheel zoom for large
 * diagrams, the copy control copies the Mermaid source, and MessageMarkdown
 * composes this automatically for ```mermaid fences.
 */
function MermaidDiagram({
  chart,
  mode,
  streaming = false,
  defaultExpanded = false,
  className,
  ...props
}: MermaidDiagramProps) {
  const config = useCodeBlockConfig()
  const diagramWindow = React.useContext(DiagramWindowContext)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const { expanded, expand, viewer } = useDiagramViewer(rootRef, { defaultExpanded })
  const resolvedMode = mode ?? config.mode ?? "system"
  // The svg is stored with the chart it was rendered from, so "is the
  // on-screen render current?" is answerable — after streaming ends, the
  // reveal must wait for the final chart's render, not a stale prefix that
  // happened to parse during a lull.
  const [rendered, setRendered] = React.useState<{
    chart: string
    svg: string
  } | null>(null)
  // The most recent chart whose render failed: with streaming source that
  // is routine mid-stream noise, but once the source is final it is the
  // terminal state — without it an unparseable chart would shimmer
  // "Drawing diagram" forever.
  const [failedChart, setFailedChart] = React.useState<string | null>(null)
  // Whether the reveal morph has finished; the expand control stays out of
  // the tab order until the diagram is actually visible.
  const [settled, setSettled] = React.useState(false)
  // Once a host drives the streaming prop, the instance latches into the
  // stricter contract for good: reveals are gated on the render being
  // current, and a final source that fails falls back to raw text even
  // over a stale prefix render. Hosts that never pass it keep the original
  // keep-last-render-on-screen behavior for changing charts. Latched in an
  // effect so a discarded render can't flip it.
  const everStreamed = React.useRef(false)
  React.useEffect(() => {
    if (streaming) everStreamed.current = true
  }, [streaming])
  // Track the OS scheme live so `system` diagrams re-render when it flips,
  // matching how code blocks follow the scheme through Pierre.
  const [systemDark, setSystemDark] = React.useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  )
  React.useEffect(() => {
    if (resolvedMode !== "system" || typeof window === "undefined") return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    setSystemDark(media.matches)
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [resolvedMode])
  const isDark =
    resolvedMode === "dark" || (resolvedMode === "system" && systemDark)

  React.useEffect(() => {
    let cancelled = false
    // Debounce until the source goes quiet: while a diagram streams in, the
    // chart changes on every animation frame and many prefixes parse
    // successfully, so rendering eagerly re-lays out the whole SVG dozens of
    // times — visible jitter, especially for sequence diagrams. Waiting for
    // a short pause renders once per lull instead, and a static chart (the
    // usual case outside streaming) only defers its first paint by the delay.
    let watchdog: number | undefined
    const timer = window.setTimeout(() => {
      renderQueue = renderQueue
        .then(async () => {
          if (cancelled) return
          // The watchdog is armed here — when this task actually dequeues —
          // not when it was enqueued: renderQueue is shared by every diagram
          // on the page, so a reply with a dozen fences can leave the last
          // one queued for longer than the timeout through no fault of its
          // own, and arming at enqueue time would fail it while it was
          // merely waiting its turn. It only guards against a render that
          // never resolves, converting an eternal shimmer into the readable
          // source fallback.
          watchdog = window.setTimeout(() => {
            if (!cancelled) setFailedChart(chart)
          }, RENDER_TIMEOUT)
          try {
            mermaid.initialize({
              startOnLoad: false,
              securityLevel: "strict",
              suppressErrorRendering: true,
              theme: isDark ? "dark" : "default",
              // Mermaid's stock dark edge-label background leaves label
              // text at 4.43:1 — just under WCAG AA. A darker backdrop
              // clears the threshold.
              themeVariables: isDark
                ? { edgeLabelBackground: "#1f1f1f" }
                : undefined,
            })
            const result = await mermaid.render(
              `nessa-mermaid-${++renderSequence}`,
              chart,
            )
            if (!cancelled) {
              setRendered({ chart, svg: result.svg })
              setFailedChart(null)
            }
          } catch {
            // Mid-stream source is often momentarily invalid; keep the
            // previous successful render on screen, but record the failure
            // so a chart that never parses can settle into its fallback
            // instead of generating forever.
            if (!cancelled) setFailedChart(chart)
          } finally {
            window.clearTimeout(watchdog)
          }
        })
        .catch(() => {})
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(watchdog)
    }
  }, [chart, isDark])

  // Terminal failure: the source is final and its render failed, so the
  // surface settles instead of generating forever.
  const failedCurrent = !streaming && failedChart === chart
  // What a failed final source settles into. A render of *this* chart
  // always wins: re-renders fire on every theme flip, and one of those
  // failing must never discard a diagram that is already correct on
  // screen. Otherwise a streaming host prefers the muted raw source over a
  // stale prefix render — a truncated diagram would read as finished —
  // while a keep-last host only falls back when nothing ever rendered.
  const showSourceFallback =
    failedCurrent &&
    rendered?.chart !== chart &&
    (rendered === null || everStreamed.current)
  const generating =
    streaming ||
    (rendered === null
      ? !failedCurrent
      : everStreamed.current && rendered.chart !== chart && !failedCurrent)

  React.useEffect(() => {
    if (generating) setSettled(false)
  }, [generating])

  // Whether the diagram is on screen and readable, which is exactly when
  // expanding it makes sense. Derived during render rather than in an
  // effect so the control disappears in the same commit that starts a new
  // generation, instead of lingering for one painted frame.
  const expandable =
    rendered !== null && !showSourceFallback && !generating && settled

  return (
    <div
      ref={rootRef}
      data-slot="mermaid-diagram"
      className={cn(
        "group/copy relative min-w-0 max-w-full overflow-x-auto",
        className,
      )}
      {...props}
    >
      <GeneratingSurface
        generating={generating}
        label="Drawing diagram"
        onSettled={() => setSettled(true)}
      >
        {showSourceFallback ? (
          <pre className="overflow-x-auto whitespace-pre-wrap py-1 font-mono text-[0.8125em] text-muted-foreground">
            {chart}
          </pre>
        ) : rendered !== null ? (
          <div
            className="[&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: rendered.svg }}
          />
        ) : null}
      </GeneratingSurface>
      {(expandable || expanded) && (
        <button
          type="button"
          aria-label="Expand diagram"
          onClick={expand}
          className="absolute right-11 top-0 flex size-7 items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 [&_svg]:size-3.5"
        >
          <Maximize2 aria-hidden="true" />
        </button>
      )}
      {expandable && diagramWindow !== null && (
        <button
          type="button"
          aria-label="Open diagram in a new window"
          onClick={() => diagramWindow.open(chart)}
          className="absolute right-20 top-0 flex size-7 items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 [&_svg]:size-3.5"
        >
          <SquareArrowOutUpRight aria-hidden="true" />
        </button>
      )}
      <CopyButton text={chart} label="Copy diagram source" className="top-0" />
      {/*
        The viewer and its trigger are mounted together for as long as the
        viewer is open — the trigger's gate above keeps it alive while
        `expanded`. A modal dialog restores focus to whatever was focused
        when it opened, so letting the viewer outlive its trigger (a chunk
        arriving mid-read puts the diagram back to generating) would drop
        the keyboard user to the top of the document on close.
      */}
      {rendered !== null &&
        viewer(
          <div className="[&_svg]:h-auto [&_svg]:max-w-none" dangerouslySetInnerHTML={{ __html: rendered.svg }} />,
          { refitKey: rendered.svg, onOpenWindow: diagramWindow === null ? undefined : () => diagramWindow.open(chart) },
        )}
    </div>
  )
}

export { DiagramWindowProvider, MermaidDiagram, type DiagramWindowValue }
