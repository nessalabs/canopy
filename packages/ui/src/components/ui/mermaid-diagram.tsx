"use client"

import * as React from "react"
import mermaid from "mermaid"
import { Hand, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react"

import { cn } from "@/lib/utils"
import { CopyButton, useCodeBlockConfig, type CodeBlockMode } from "./code-block"
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

const MIN_SCALE = 0.2
const MAX_SCALE = 8
/** Fit-to-screen never scales a small diagram beyond this. */
const MAX_FIT_SCALE = 2
/** Breathing room around a fitted diagram, in pixels. */
const FIT_PADDING = 48

interface ViewerTransform {
  x: number
  y: number
  scale: number
}

/**
 * The active interaction tool in the fullscreen viewer. `pan` drags the
 * canvas; the union leaves room for future tools (selection, annotation)
 * without reshaping the viewer.
 */
type ViewerTool = "pan" | null

const viewerButtonClass =
  "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-4"

/**
 * The fullscreen diagram viewer: a modal dialog for diagrams too large to
 * read inline. Drag-to-pan is active by default and the hand tool toggles
 * it, the wheel and toolbar zoom toward the cursor, and the tool strip is a
 * ViewerTool union so more interactions can slot in later. The dialog
 * element owns focus and the Escape key natively.
 */
function MermaidViewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [view, setView] = React.useState<ViewerTransform>({ x: 48, y: 48, scale: 1 })
  // Panning is the expected default; the hand tool toggles it off for
  // future interactions that want the pointer for something else.
  const [tool, setTool] = React.useState<ViewerTool>("pan")
  const [dragging, setDragging] = React.useState(false)
  const dragState = React.useRef({ pointerId: 0, lastX: 0, lastY: 0 })
  const viewRef = React.useRef(view)
  viewRef.current = view

  // Scales the diagram to fit the stage (never past MAX_FIT_SCALE) and
  // centers it — the state the viewer opens in, and what Reset returns to.
  const fit = React.useCallback(() => {
    const stage = stageRef.current
    const content = contentRef.current
    if (!stage || !content) return
    const stageRect = stage.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const baseWidth = contentRect.width / viewRef.current.scale
    const baseHeight = contentRect.height / viewRef.current.scale
    if (baseWidth <= 0 || baseHeight <= 0) return
    const scale = Math.max(
      MIN_SCALE,
      Math.min(
        (stageRect.width - FIT_PADDING * 2) / baseWidth,
        (stageRect.height - FIT_PADDING * 2) / baseHeight,
        MAX_FIT_SCALE,
      ),
    )
    setView({
      scale,
      x: (stageRect.width - baseWidth * scale) / 2,
      y: (stageRect.height - baseHeight * scale) / 2,
    })
  }, [])

  React.useEffect(() => {
    dialogRef.current?.showModal()
    // Fit after the dialog has laid out so the measurements are real.
    const frame = requestAnimationFrame(fit)
    const stage = stageRef.current
    if (!stage) return () => cancelAnimationFrame(frame)
    // Zoom toward the cursor; a native non-passive listener is required to
    // preventDefault on wheel events. The factor scales with the wheel delta
    // (clamped per event) instead of a fixed step, so trackpads — which fire
    // many small-delta events per gesture — zoom at the same comfortable
    // rate as discrete mouse-wheel notches.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = Math.min(1.2, Math.max(1 / 1.2, Math.exp(-event.deltaY * 0.002)))
      const rect = stage.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      setView((current) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
        const applied = scale / current.scale
        return {
          scale,
          x: pointerX - (pointerX - current.x) * applied,
          y: pointerY - (pointerY - current.y) * applied,
        }
      })
    }
    stage.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      stage.removeEventListener("wheel", onWheel)
    }
  }, [fit])

  // Re-fit when the diagram changes underneath an open viewer — the host
  // regenerated the source while the user was reading it. Without this the
  // new drawing inherits the pan and zoom computed for the old one, which
  // lands the reader on an arbitrary crop of content they never framed.
  // The mount effect above already fits the first diagram; this skips that
  // pass rather than fighting it, and showModal() is deliberately left out
  // of it since re-opening an open dialog throws.
  // Holds the drawing that has been fitted, seeded with the one this
  // viewer opened on. Comparing values rather than counting runs keeps the
  // skip correct however many times the effect is invoked — a flag would
  // be consumed by StrictMode's simulated remount, and resetting that flag
  // from the cleanup would instead swallow every genuine re-fit, since
  // cleanup runs on each dependency change and not only on unmount.
  const fittedSvg = React.useRef(svg)
  React.useEffect(() => {
    if (fittedSvg.current === svg) return
    fittedSvg.current = svg
    const frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [svg, fit])

  const zoomBy = (factor: number) => {
    const stage = stageRef.current
    const rect = stage?.getBoundingClientRect()
    const centerX = rect === undefined ? 0 : rect.width / 2
    const centerY = rect === undefined ? 0 : rect.height / 2
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
      const applied = scale / current.scale
      return {
        scale,
        x: centerX - (centerX - current.x) * applied,
        y: centerY - (centerY - current.y) * applied,
      }
    })
  }

  return (
    <dialog
      ref={dialogRef}
      data-slot="mermaid-viewer"
      aria-label="Diagram viewer"
      onClose={onClose}
      className="h-dvh max-h-none w-dvw max-w-none bg-background p-0 text-foreground"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <span className="nessa-text-4 font-medium">Diagram</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Pan tool"
              aria-pressed={tool === "pan"}
              data-active={tool === "pan" ? "true" : undefined}
              className={cn(
                viewerButtonClass,
                "data-[active=true]:bg-muted data-[active=true]:text-foreground",
              )}
              onClick={() => setTool((current) => (current === "pan" ? null : "pan"))}
            >
              <Hand aria-hidden="true" />
            </button>
            <span aria-hidden="true" className="h-5 w-px bg-border" />
            <button
              type="button"
              aria-label="Zoom out"
              className={viewerButtonClass}
              onClick={() => zoomBy(1 / 1.25)}
            >
              <ZoomOut aria-hidden="true" />
            </button>
            <span className="w-12 text-center nessa-text-2 tabular-nums text-muted-foreground">
              {Math.round(view.scale * 100)}%
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              className={viewerButtonClass}
              onClick={() => zoomBy(1.25)}
            >
              <ZoomIn aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Reset view"
              className={viewerButtonClass}
              onClick={fit}
            >
              <RotateCcw aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Close viewer"
              className={viewerButtonClass}
              onClick={() => dialogRef.current?.close()}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          ref={stageRef}
          data-tool={tool ?? undefined}
          data-dragging={dragging ? "true" : undefined}
          className="relative flex-1 touch-none overflow-hidden data-[tool=pan]:cursor-grab data-[dragging=true]:cursor-grabbing"
          onPointerDown={(event) => {
            if (tool !== "pan" || event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            dragState.current = {
              pointerId: event.pointerId,
              lastX: event.clientX,
              lastY: event.clientY,
            }
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (!dragging || event.pointerId !== dragState.current.pointerId) return
            // Pan incrementally from the last pointer position rather than
            // from the pointer-down origin, so a wheel zoom mid-drag (which
            // retargets the translation toward the cursor) composes instead
            // of snapping back to the pre-zoom pan.
            const deltaX = event.clientX - dragState.current.lastX
            const deltaY = event.clientY - dragState.current.lastY
            dragState.current.lastX = event.clientX
            dragState.current.lastY = event.clientY
            setView((current) => ({
              ...current,
              x: current.x + deltaX,
              y: current.y + deltaY,
            }))
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        >
          <div
            ref={contentRef}
            className="absolute left-0 top-0 w-max origin-top-left [&_svg]:h-auto [&_svg]:max-w-none"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </dialog>
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
  className,
  ...props
}: MermaidDiagramProps) {
  const config = useCodeBlockConfig()
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
  const [expanded, setExpanded] = React.useState(false)
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
          onClick={() => setExpanded(true)}
          className="absolute right-11 top-0 flex size-7 items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 [&_svg]:size-3.5"
        >
          <Maximize2 aria-hidden="true" />
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
      {expanded && rendered !== null && (
        <MermaidViewer svg={rendered.svg} onClose={() => setExpanded(false)} />
      )}
    </div>
  )
}

export { MermaidDiagram }
