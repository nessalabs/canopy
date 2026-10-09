"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Hand, RotateCcw, SquareArrowOutUpRight, X, ZoomIn, ZoomOut } from "lucide-react"

import { cn } from "@/lib/utils"

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
 * The active interaction tool in the viewer. `pan` drags the canvas; the
 * union leaves room for future tools (selection, annotation) without
 * reshaping the viewer.
 */
type ViewerTool = "pan" | null

const viewerButtonClass =
  "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-4"

/**
 * How far an expanded diagram grows. A host that marks a positioned region
 * with `data-diagram-surface` — an editor pane, a card — gets the viewer
 * filling that region, so the rest of the app stays readable beside it;
 * with no such ancestor the viewer covers the window as a modal dialog.
 */
const DIAGRAM_SURFACE_SELECTOR = "[data-diagram-surface]"

/** A press that starts on a control is a click on it, never the start of a pan. */
const INTERACTIVE = "button, a, input, select, textarea, [role=button]"

export interface DiagramViewerProps {
  /** What the viewer shows: any drawing, at its natural size. */
  children: React.ReactNode
  onClose: () => void
  /** Fill the nearest diagram surface rather than the whole window. */
  inline?: boolean
  /** Offers "open in a new window" when given. */
  onOpenWindow?: () => void
  /** Changes when the drawing does, so an open viewer fits the new one rather than keeping the old framing. */
  refitKey?: unknown
}

/**
 * The expanded diagram viewer, for diagrams too large to read inline — a
 * Mermaid drawing, a change map, any canvas. Drag-to-pan is active by
 * default and the hand tool toggles it, the wheel and toolbar zoom toward
 * the cursor, and Reset fits the drawing to the stage. Controls inside the
 * drawing stay clickable: a press on one never starts a pan.
 *
 * `inline` fills the host's diagram surface instead of the window: the
 * dialog element owns focus and Escape natively, so the inline frame takes
 * both on itself.
 */
function DiagramViewer({ children, onClose, inline = false, onOpenWindow, refitKey }: DiagramViewerProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
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
      Math.min((stageRect.width - FIT_PADDING * 2) / baseWidth, (stageRect.height - FIT_PADDING * 2) / baseHeight, MAX_FIT_SCALE),
    )
    setView({ scale, x: (stageRect.width - baseWidth * scale) / 2, y: (stageRect.height - baseHeight * scale) / 2 })
  }, [])

  React.useEffect(() => {
    // The dialog takes the top layer and the focus; the inline frame is an
    // ordinary element, so it asks for the focus itself — that is what puts
    // its Escape handler and its toolbar in reach of the keyboard.
    if (inline) frameRef.current?.focus()
    else dialogRef.current?.showModal()
    // Fit after the viewer has laid out so the measurements are real.
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
        return { scale, x: pointerX - (pointerX - current.x) * applied, y: pointerY - (pointerY - current.y) * applied }
      })
    }
    stage.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      stage.removeEventListener("wheel", onWheel)
    }
  }, [fit, inline])

  // Escape closes an inline viewer wherever the focus went — a pan drag
  // leaves it on the stage, a toolbar click on a button. The dialog gets
  // this from the platform.
  React.useEffect(() => {
    if (!inline) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [inline, onClose])

  /** Closes either shape: the dialog through the platform, the frame directly. */
  const close = () => {
    if (inline) onClose()
    else dialogRef.current?.close()
  }

  // Re-fit when the drawing changes underneath an open viewer — the host
  // regenerated it while the user was reading. Without this the new drawing
  // inherits the pan and zoom computed for the old one. The mount effect
  // already fits the first drawing; comparing values rather than counting
  // runs keeps that skip correct under StrictMode's simulated remount.
  const fittedKey = React.useRef(refitKey)
  React.useEffect(() => {
    if (fittedKey.current === refitKey) return
    fittedKey.current = refitKey
    const frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [refitKey, fit])

  const zoomBy = (factor: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    const centerX = rect === undefined ? 0 : rect.width / 2
    const centerY = rect === undefined ? 0 : rect.height / 2
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
      const applied = scale / current.scale
      return { scale, x: centerX - (centerX - current.x) * applied, y: centerY - (centerY - current.y) * applied }
    })
  }

  const body = (
    <div className="flex h-full flex-col">
      {/*
        A window whose native title bar is drawn over the page — an Electron shell with
        macOS traffic lights, say — keeps the mouse events over that strip for itself, so a
        toolbar drawn inside it is unreadable under the window controls and barely
        clickable. The host publishes the strip's height as --nessa-title-bar-inset; the
        toolbar starts below it, and is flush with the top edge everywhere else.
      */}
      <div
        className="flex items-center justify-between gap-2 border-b border-border px-4 py-2"
        style={inline ? undefined : { paddingTop: "calc(var(--nessa-title-bar-inset, 0px) + 0.5rem)" }}
      >
        <span className="nessa-text-4 font-medium">Diagram</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Pan tool"
            aria-pressed={tool === "pan"}
            data-active={tool === "pan" ? "true" : undefined}
            className={cn(viewerButtonClass, "data-[active=true]:bg-muted data-[active=true]:text-foreground")}
            onClick={() => setTool((current) => (current === "pan" ? null : "pan"))}
          >
            <Hand aria-hidden="true" />
          </button>
          <span aria-hidden="true" className="h-5 w-px bg-border" />
          <button type="button" aria-label="Zoom out" className={viewerButtonClass} onClick={() => zoomBy(1 / 1.25)}>
            <ZoomOut aria-hidden="true" />
          </button>
          <span className="w-12 text-center nessa-text-2 tabular-nums text-muted-foreground">{Math.round(view.scale * 100)}%</span>
          <button type="button" aria-label="Zoom in" className={viewerButtonClass} onClick={() => zoomBy(1.25)}>
            <ZoomIn aria-hidden="true" />
          </button>
          <button type="button" aria-label="Reset view" className={viewerButtonClass} onClick={fit}>
            <RotateCcw aria-hidden="true" />
          </button>
          {onOpenWindow === undefined ? null : (
            <button type="button" aria-label="Open diagram in a new window" className={viewerButtonClass} onClick={onOpenWindow}>
              <SquareArrowOutUpRight aria-hidden="true" />
            </button>
          )}
          <button type="button" aria-label="Close viewer" className={viewerButtonClass} onClick={close}>
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
          if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return
          event.currentTarget.setPointerCapture(event.pointerId)
          dragState.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
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
          setView((current) => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }))
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <div
          ref={contentRef}
          className="absolute left-0 top-0 w-max origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {children}
        </div>
      </div>
    </div>
  )

  // Inside a host's diagram surface the viewer is an ordinary element
  // filling that region, so the pane beside it stays readable and usable;
  // everywhere else it is a modal dialog over the whole window.
  if (inline) {
    return (
      <div
        ref={frameRef}
        role="dialog"
        aria-label="Diagram viewer"
        data-slot="diagram-viewer"
        data-inline="true"
        tabIndex={-1}
        className="absolute inset-0 z-30 bg-background text-foreground outline-none"
      >
        {body}
      </div>
    )
  }

  return (
    <dialog
      ref={dialogRef}
      data-slot="diagram-viewer"
      aria-label="Diagram viewer"
      onClose={onClose}
      className="h-dvh max-h-none w-dvw max-w-none bg-background p-0 text-foreground"
    >
      {body}
    </dialog>
  )
}

/**
 * Whether a diagram is open in the viewer, and the viewer itself, placed in
 * the host's diagram surface when there is one. `anchor` is any element of
 * the diagram; the surface is read from the mounted DOM when the viewer
 * opens, so every diagram under a marked region — including one deep inside
 * rendered markdown — finds it.
 */
function useDiagramViewer(anchor: React.RefObject<HTMLElement | null>, { defaultExpanded = false }: { defaultExpanded?: boolean } = {}) {
  const [expanded, setExpanded] = React.useState(false)
  const [surface, setSurface] = React.useState<HTMLElement | null>(null)
  const expand = React.useCallback(() => {
    setSurface(anchor.current?.closest<HTMLElement>(DIAGRAM_SURFACE_SELECTOR) ?? null)
    setExpanded(true)
  }, [anchor])
  // A window opened to show one diagram wants it expanded from the start.
  React.useEffect(() => {
    if (defaultExpanded) expand()
  }, [defaultExpanded, expand])
  /** Stable across renders so the viewer's Escape listener is bound once. */
  const collapse = React.useCallback(() => setExpanded(false), [])

  /** The open viewer showing `drawing`, or nothing while closed. */
  const viewer = (drawing: React.ReactNode, props: Omit<DiagramViewerProps, "children" | "onClose" | "inline"> = {}): React.ReactNode => {
    if (!expanded) return null
    if (surface === null)
      return (
        <DiagramViewer onClose={collapse} {...props}>
          {drawing}
        </DiagramViewer>
      )
    // Rendered into the host's surface rather than in place: the diagram
    // itself sits in a scrolling column, so an overlay anchored to it would
    // scroll away from the reader instead of filling the pane.
    return createPortal(
      <DiagramViewer onClose={collapse} inline {...props}>
        {drawing}
      </DiagramViewer>,
      surface,
    )
  }

  return { expanded, expand, collapse, viewer }
}

export { DiagramViewer, useDiagramViewer }
