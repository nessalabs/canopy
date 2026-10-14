import { useEffect, useMemo, useRef, useState } from 'react'

import { boxKey, currentVersion, type BoxRef, type PermissionDecisionInput, type PlanState, type WhiteboardMode } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'

import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator, type SplitViewLayout } from '@/components/split-view'
import { STATUS, STATUS_ORDER } from '@/components/ui/change-map/diagram-parts'
import { ChatTabs } from '@/components/ui/chat-tabs'
import { StatusDot } from '@/components/ui/status-dot'
import {
  useWorkflowCanvasEdgeGeometry,
  WorkflowCanvas,
  WorkflowCanvasEdge,
  WorkflowCanvasEdges,
  WorkflowCanvasGrid,
  WorkflowCanvasNode,
  WorkflowCanvasSurface,
  type WorkflowCanvasViewport
} from '@/components/ui/workflow-canvas'
import { closestAcross } from '@/lib/dom-selection'
import { readStored, writeStored } from '@/lib/local-store'
import { activeReading, readerSteps } from '@/lib/reader-tabs'
import { tabPanelProps } from '@/lib/tab-panel'
import { useReader } from '@/lib/use-reader'
import { cn } from '@/lib/utils'
import { BOARD_SIZE, boundsOf, boxInfo, layoutBoards, notesCount, READABLE, START_VIEW, threadOf, tourSteps, viewportFor, zoomAround, type Size } from '@/lib/whiteboard'
import type { Whiteboard as WhiteboardModel } from '@/lib/use-whiteboard'

import { SelectionActions } from '../selection-actions'
import { BoardDetails, BoardOnCanvas, NEW_VIEW, type BoardView } from './board-card'
import { STATUS_LABELS } from './board-drawing'
import { BoxInspector } from './box-inspector'
import { AskDrawer, BoardDrawer, TrailDrawer } from './drawers'
import { EmptyBoard } from './empty-board'
import { PlanApproval } from './plan-approval'
import { planText } from './plan-reading'
import { Toolbar } from './toolbar'
import { TourDrawer } from './tour-drawer'

/** Reports a board's drawn size, so the layout can keep boards apart however big they come out. */
function Measured({ id, onSize, children }: { id: string; onSize: (id: string, size: Size) => void; children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(() => onSize(id, { width: Math.round(element.offsetWidth), height: Math.round(element.offsetHeight) }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [id])
  return <div ref={ref}>{children}</div>
}

/** Tracks an element's size, for fitting boards into it. */
function useSize(): [React.RefObject<HTMLDivElement | null>, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, size]
}

/** The dashed line from a board to one of its detail boards, named for the box it opens. */
function DetailEdge({ parent, child, label }: { parent: string; child: string; label?: string }): React.JSX.Element {
  const geometry = useWorkflowCanvasEdgeGeometry({ source: parent, target: child })
  return (
    <WorkflowCanvasEdge source={parent} target={child} className="stroke-muted-foreground/60 [stroke-dasharray:6_6]">
      {geometry && label ? (
        <text x={geometry.midpoint.x} y={geometry.midpoint.y - 8} textAnchor="middle" className="fill-muted-foreground text-[12px]">
          inside {label}
        </text>
      ) : null}
    </WorkflowCanvasEdge>
  )
}

/** What a tab of the right-hand reader holds — every word there is to read, so the canvas keeps only pictures. */
type Drawer = { kind: 'board'; id: string } | { kind: 'box'; ref: BoxRef } | { kind: 'ask'; ref: string; quote: string } | { kind: 'trail' } | { kind: 'tour' }

const clip = (text: string, length = 28): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/** A reader tab's name: the board or box by its title, the passage asked about by its words. */
const TITLES: { [K in Drawer['kind']]: (drawer: Extract<Drawer, { kind: K }>, state: PlanState) => string } = {
  board: ({ id }, state) => { const board = state.boards[id]; return board ? currentVersion(board).title : 'Board' },
  box: ({ ref }, state) => boxInfo(state, ref)?.node.label ?? 'Box',
  ask: ({ quote }) => `“${clip(quote, 24)}”`,
  trail: () => 'Decision trail',
  tour: () => 'Walk-through'
}
const titleOf = (drawer: Drawer, state: PlanState): string => clip((TITLES[drawer.kind] as (d: Drawer, s: PlanState) => string)(drawer, state))

/** The key to the colours, in a corner of the canvas: the drawings' own colours, in the whiteboard's words. */
const ColourKey = (): React.JSX.Element => (
  <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/90 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur">
    {STATUS_ORDER.map((status) => (
      <span key={status} className="flex items-center gap-1.5">
        <span className={`size-3 rounded border ${STATUS[status].card}`} aria-hidden="true" />
        {STATUS_LABELS[status]}
      </span>
    ))}
    <span className="border-l border-border pl-3">Double-click a box to go inside</span>
  </div>
)

/** Where the width the reader gave the drawer is kept, so it holds across sessions and reloads. */
const SPLIT_KEY = 'canopy-whiteboard-split'

// The drawer sits in a resizable panel whose separator already draws the line between it and the canvas.
const DRAWER_CLASS = 'border-l-0'

/** Where a selected passage sits: the board it was read on, or the plan document. */
const passageRef = (range: Range): string | undefined =>
  closestAcross(range.commonAncestorContainer, '[data-plan-doc]') ? 'plan' : (closestAcross(range.commonAncestorContainer, '[data-board-id]')?.getAttribute('data-board-id') ?? undefined)

export interface WhiteboardProps {
  whiteboard: WhiteboardModel
  turns: readonly Turn[]
  mode?: WhiteboardMode
  onMode: (mode: WhiteboardMode) => void
  busy: boolean
  onAnswerPermission: (input: PermissionDecisionInput) => void
  /** Opens a board in a panel of its own beside the whiteboard. */
  onOpenBeside: (board: string) => void
  /** Opens a `path:lines` reference in the code panel. */
  onOpenRef?: (ref: string) => void
  /** Shows what the build changed in a box's files. */
  onShowChanges?: (files: string[]) => void
  /** Opens the plan in the Reader beside the whiteboard, so it reads alongside a box. */
  onReadPlan: () => void
}

/**
 * The whiteboard: every board the conversation drew, on one pannable, zoomable canvas — the overview
 * first, each detail board beside the box it opens. Clicking a box, selecting a passage, the plan
 * and the decision trail each open beside the canvas; a walk-through reads the plan out step by step.
 */
export function Whiteboard({ whiteboard, turns, mode, onMode, busy, onAnswerPermission, onOpenBeside, onOpenRef, onShowChanges, onReadPlan }: WhiteboardProps): React.JSX.Element {
  const { view, approval, cost } = whiteboard
  const { state } = view
  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const measure = (id: string, size: Size): void => setSizes((current) => (current[id]?.width === size.width && current[id]?.height === size.height ? current : { ...current, [id]: size }))
  const layout = useMemo(() => layoutBoards(state, sizes), [state, sizes])
  const sizeOf = (id: string): Size => sizes[id] ?? BOARD_SIZE
  // Where the reader dragged a board wins over where the layout put it.
  const positions = { ...layout, ...whiteboard.moved }
  // How each board is being looked at — version, today or after — shared by canvas and sidebar.
  const [views, setViews] = useState<Record<string, BoardView>>({})
  const viewOf = (id: string): BoardView => views[id] ?? NEW_VIEW
  // Boxes a hovered paragraph of a board's story talks about, lit up on the canvas.
  const [lit, setLit] = useState<{ board: string; ids: string[] }>()
  // The reader beside the canvas keeps a tab for each thing opened, so going back and forth is a click;
  // it stays open while the canvas is panned, and each tab closes from its own ✕.
  const reader = useReader<Drawer>()
  const drawer = reader.current
  const [split] = useState(() => readStored<SplitViewLayout>(SPLIT_KEY))
  const [current, setCurrent] = useState<string>()
  const [tour, setTour] = useState<number>()
  const steps = useMemo(() => tourSteps(state), [state])
  const root = useRef<HTMLDivElement>(null)
  const [frame, size] = useSize()
  const [viewport, setViewport] = useState<WorkflowCanvasViewport>(START_VIEW)

  const fit = (): void => {
    const placed = Object.entries(positions).map(([id, at]) => ({ ...at, ...sizeOf(id) }))
    if (placed.length > 0 && size.width > 0) setViewport(viewportFor(boundsOf(placed), size.width, size.height))
  }
  const focusBoard = (id: string): void => {
    const at = positions[id]
    setCurrent(id)
    if (at && size.width > 0) setViewport(viewportFor({ ...at, ...sizeOf(id) }, size.width, size.height, READABLE))
  }
  const zoom = (factor: number): void => setViewport((now) => zoomAround(now, factor, { x: size.width / 2, y: size.height / 2 }))

  /** A board to read: in view on the canvas, its story in the sidebar. */
  const readBoard = (id: string): void => {
    focusBoard(id)
    reader.show({ kind: 'board', id })
  }
  // A new board flies into view as it is drawn, with its story beside it unless something else is being read.
  const newest = state.order.at(-1)
  useEffect(() => {
    if (!newest) return
    focusBoard(newest)
    // It takes over the board tab on screen rather than opening a tab per board drawn.
    reader.update((now) => {
      const reading = activeReading(now)
      return reading === undefined || reading.kind === 'board' ? readerSteps.open(now, { kind: 'board', id: newest }) : now
    })
  }, [newest, size.width > 0])
  // The walk-through brings each step's board into view.
  const step = drawer?.kind === 'tour' && tour !== undefined ? steps[tour] : undefined
  useEffect(() => {
    if (step) focusBoard(step.board)
  }, [step?.board])
  /** Double-clicking a box goes inside it: to its detail board, or the agent is asked to draw one. */
  const openBox = (ref: BoxRef): void => {
    if (whiteboard.drill(ref, readBoard) === 'asked') reader.show({ kind: 'box', ref })
  }
  const litOn = (id: string): string[] => [...(lit?.board === id ? lit.ids : []), ...(step?.board === id && step.box ? [step.box] : [])]

  // A passage selected in a box's tab waits in that tab's ask bar, as context for the question typed next.
  const [staged, setStaged] = useState<Record<string, string>>({})
  /** "Ask the agent" on a selection asks nothing yet: the passage is staged where the question gets written. */
  const ask = (text: string, range: Range): void => {
    const inBox = drawer?.kind === 'box' && reader.state.active && closestAcross(range.commonAncestorContainer, '[data-whiteboard-reader]')
    if (inBox) return setStaged((now) => ({ ...now, [reader.state.active!]: text }))
    reader.show({ kind: 'ask', ref: passageRef(range) ?? current ?? state.order[0] ?? 'plan', quote: text })
  }
  const closeTab = (id: string): void => {
    reader.close(id)
    setLit(undefined)
  }
  const close = (): void => {
    if (reader.state.active) closeTab(reader.state.active)
  }
  // The approval card, once put away, answers from under the plan in the Reader instead — until the next ask.
  const [hiddenAsk, setHiddenAsk] = useState<string>()
  const askHidden = approval !== undefined && approval.id === hiddenAsk

  const selected = drawer?.kind === 'box' ? drawer.ref : undefined
  const info = selected && boxInfo(state, selected, state.boards[selected.board]?.versions[viewOf(selected.board).version ?? -1])
  const DRAWERS: Record<Drawer['kind'], () => React.ReactNode> = {
    board: () => {
      const board = drawer?.kind === 'board' ? state.boards[drawer.id] : undefined
      if (!board) return null
      return (
        <BoardDrawer onClose={close} className={DRAWER_CLASS}>
          {/* Named as the board, so a passage selected in its story is asked about on that board. */}
          <div data-board-id={board.id} className="contents">
            <BoardDetails
              board={board}
              state={state}
              view={viewOf(board.id)}
              onView={(next) => setViews((now) => ({ ...now, [board.id]: next }))}
              onDecide={whiteboard.decide}
              onHover={(ids) => setLit({ board: board.id, ids })}
              onOpenParent={board.parent ? () => readBoard(board.parent!.board) : undefined}
              onOpenBeside={() => onOpenBeside(board.id)}
            />
          </div>
        </BoardDrawer>
      )
    },
    tour: () => <TourDrawer steps={steps} index={tour ?? 0} onIndex={setTour} onClose={close} className={DRAWER_CLASS} />,
    box: () =>
      info ? (
        <BoxInspector
          info={info}
          thread={threadOf(turns, view.threads[boxKey(info.ref)])}
          busy={busy}
          waiting={whiteboard.waiting}
          onAsk={(question) => whiteboard.ask(info.ref, info.node.label, question)}
          onDraw={(question) => whiteboard.draw(info.ref, info.node.label, question)}
          quote={reader.state.active ? staged[reader.state.active] : undefined}
          onDropQuote={() => setStaged(({ [reader.state.active ?? '']: _dropped, ...rest }) => rest)}
          onOpenDetail={() => info.detail && readBoard(info.detail)}
          onOpenRef={onOpenRef}
          onShowChanges={onShowChanges}
          notes={whiteboard.notes[boxKey(info.ref)] ?? []}
          onAddNote={(note) => whiteboard.addNote(info.ref, note)}
          onRemoveNote={(index) => whiteboard.removeNote(info.ref, index)}
          onClose={close}
          className={DRAWER_CLASS}
        />
      ) : null,
    ask: () =>
      drawer?.kind === 'ask' ? (
        <AskDrawer view={view} turns={turns} quote={drawer.quote} refId={drawer.ref} busy={busy} waiting={whiteboard.waiting} onAsk={(question) => whiteboard.quote(drawer.ref, drawer.quote, question)} onClose={close} className={DRAWER_CLASS} />
      ) : null,
    trail: () => <TrailDrawer view={view} turns={turns} onOpenRef={onOpenRef} onClose={close} className={DRAWER_CLASS} />
  }
  const toggleTrail = (): void => (drawer?.kind === 'trail' ? close() : reader.show({ kind: 'trail' }))

  return (
    <div ref={root} className="@container flex h-full min-h-0 flex-col bg-background">
      <SelectionActions host={root} onAsk={ask} askLabel="Ask the agent" askHint="Explain what this is and how it fits in" highlights={whiteboard.sessionId && `board:${whiteboard.sessionId}`} />
      <Toolbar
        state={state}
        mode={mode}
        busy={busy || view.drawing}
        cost={cost}
        current={current}
        drawer={drawer?.kind}
        hasPlan={planText(whiteboard) !== ''}
        planWaiting={askHidden}
        notes={notesCount(whiteboard.notes)}
        onFocus={readBoard}
        onDrawing={(board, version) => {
          setViews((now) => ({ ...now, [board]: { ...viewOf(board), version } }))
          readBoard(board)
        }}
        onTour={() => {
          setTour(0)
          reader.show({ kind: 'tour' })
        }}
        onPlan={onReadPlan}
        onTrail={toggleTrail}
        onSendNotes={whiteboard.sendNotes}
        onZoom={zoom}
        onFit={fit}
      />
      {approval && !askHidden ? (
        <div className="border-b border-border bg-muted/30 p-2">
          <PlanApproval ask={approval} onAnswer={onAnswerPermission} onReadPlan={onReadPlan} onDismiss={() => setHiddenAsk(approval.id)} />
        </div>
      ) : null}
      {/* The drawer panel stays mounted while closed, so the width the reader dragged it to holds from one drawer to the next. */}
      <SplitView orientation={SplitViewOrientation.Horizontal} defaultLayout={split} onLayoutCommit={(layout) => writeStored(SPLIT_KEY, layout)} className="min-h-0 flex-1">
        <SplitViewPanel id="whiteboard-canvas" minSize={30} className="min-h-0">
          <div ref={frame} className="relative h-full min-w-0">
            {state.order.length === 0 ? (
              busy ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <StatusDot status="running" />
                  Reading the code before drawing…
                </div>
              ) : (
                <EmptyBoard mode={mode} onMode={onMode} />
              )
            ) : (
              <WorkflowCanvas viewport={viewport} onViewportChange={setViewport} aria-label="Whiteboard" className="h-full w-full">
                <WorkflowCanvasGrid />
                <WorkflowCanvasSurface>
                  <WorkflowCanvasEdges>
                    {state.order.flatMap((id) => {
                      const parent = state.boards[id]!.parent
                      const board = parent && state.boards[parent.board]
                      return board ? [<DetailEdge key={id} parent={parent.board} child={id} label={currentVersion(board).graph.nodes.find((node) => node.id === parent.box)?.label} />] : []
                    })}
                  </WorkflowCanvasEdges>
                  {state.order.map((id) => (
                    <WorkflowCanvasNode key={id} nodeId={id} position={positions[id]} onPositionChange={(next) => whiteboard.move(id, next)}>
                      <Measured id={id} onSize={measure}>
                        <BoardOnCanvas
                          board={state.boards[id]!}
                          state={state}
                          view={viewOf(id)}
                          selectedBox={selected?.board === id ? selected.box : undefined}
                          onSelectBox={(box) => reader.show({ kind: 'box', ref: { board: id, box } })}
                          onOpenBox={(box) => openBox({ board: id, box })}
                          onOpenDetails={() => readBoard(id)}
                          lit={litOn(id)}
                          reading={drawer?.kind === 'board' && drawer.id === id}
                        />
                      </Measured>
                    </WorkflowCanvasNode>
                  ))}
                </WorkflowCanvasSurface>
              </WorkflowCanvas>
            )}
            {state.order.length > 0 ? <ColourKey /> : null}
          </div>
        </SplitViewPanel>
        <SplitViewSeparator aria-label="Resize the drawer" className={drawer ? undefined : 'hidden'} />
        <SplitViewPanel id="whiteboard-drawer" defaultSize={30} minSize={20} maxSize={70} className={cn('min-h-0', !drawer && 'hidden')}>
          {drawer && reader.state.active ? (
            <div data-whiteboard-reader className="flex h-full min-h-0 flex-col">
              {reader.state.tabs.length > 1 ? (
                <ChatTabs
                  tabs={reader.state.tabs.map((t) => ({ id: t.id, title: titleOf(t.trail.at(-1)!, state), closeable: true }))}
                  value={reader.state.active}
                  onValueChange={(id) => {
                    reader.select(id)
                    // The canvas follows the tab: a board's, or the board a box sits on.
                    const reading = reader.state.tabs.find((tab) => tab.id === id)?.trail.at(-1)
                    if (reading?.kind === 'board') focusBoard(reading.id)
                    if (reading?.kind === 'box') focusBoard(reading.ref.board)
                  }}
                  onClose={closeTab}
                  label="Open in the reader"
                  className="shrink-0 border-b border-border px-2 py-1 [&_[data-slot=chat-tab]]:rounded-[4px]"
                />
              ) : null}
              <div {...(reader.state.tabs.length > 1 ? tabPanelProps(reader.state.active, titleOf(drawer, state)) : {})} className="min-h-0 flex-1">
                {DRAWERS[drawer.kind]()}
              </div>
            </div>
          ) : null}
        </SplitViewPanel>
      </SplitView>
    </div>
  )
}
