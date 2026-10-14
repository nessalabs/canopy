import { useState } from 'react'
import { ChevronLeft, ChevronRight, CornerLeftUp, PanelRightOpen, Scale } from 'lucide-react'

import { boardDrawing, type Board, type BoardVersion, type Choice, type GraphNode, type PlanDrawing, type PlanState, type ProgressStatus } from '@canopy/shared'

import { MessageMarkdown } from '@/components/ui/message-markdown'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { boxLines, decisionsOn, mentionedBoxes, progressOn } from '@/lib/whiteboard'
import { cn } from '@/lib/utils'

import { BoardDrawing } from './board-drawing'
import { DecisionDeck } from './decision-deck'
import { IconButton } from './icon-button'

/**
 * A board in two halves. On the canvas it is the picture itself — a title and the diagram at its
 * natural size, nothing to scroll. Everything to read about it — the story, today against after,
 * its versions, the decisions it asks for — sits in the sidebar (`BoardDetails`).
 */

/** What kind of picture a board is, in the reader's words. */
const KIND_LABEL: Record<PlanDrawing['type'], string> = {
  'change-map': 'Parts',
  activity: 'Steps',
  'call-flow': 'Sequence',
  'state-machine': 'Lifecycle',
  'data-model': 'Data'
}

/** How a board is being looked at: which version, and the picture of today or after the change. */
export interface BoardView {
  version?: number
  today: boolean
}

export const NEW_VIEW: BoardView = { today: false }

const shownOf = (board: Board, view: BoardView): { index: number; shown: BoardVersion } => {
  const index = view.version ?? board.versions.length - 1
  return { index, shown: board.versions[index]! }
}

/** The label of the box a detail board opens, on its parent board. */
const viaOf = (state: PlanState, board: Board): string | undefined => {
  const parent = board.parent && state.boards[board.parent.board]
  return parent?.versions.at(-1)?.graph.nodes.find((node) => node.id === board.parent!.box)?.label
}

/** The box a double-click landed on, by the id each diagram box carries. */
const onBox =
  (open: (boxId: string) => void) =>
  (event: React.MouseEvent): void => {
    const box = (event.target as Element).closest?.('[data-node-id]')?.getAttribute('data-node-id')
    if (box) open(box)
  }

/** How a box's build progress shows on any shape — a ring inside the border — so a decision or an end, which has no second line, still says so. */
const PROGRESS_LOOK: Record<ProgressStatus, string> = {
  doing: 'box-shadow:inset 0 0 0 2px var(--nessa-diff-modification)',
  done: 'box-shadow:inset 0 0 0 2px var(--nessa-diff-addition)'
}

/** Marks boxes of a board by id: how far their build has got, those a version changed, and those lit from outside. */
export function Spotlight({ boardId, lit, changed, progress = {} }: { boardId: string; lit: readonly string[]; changed: readonly string[]; progress?: Readonly<Record<string, ProgressStatus>> }): React.JSX.Element | null {
  const rule = (ids: readonly string[], style: string): string => (ids.length === 0 ? '' : ids.map((id) => `[data-board-id="${CSS.escape(boardId)}"] [data-node-id="${CSS.escape(id)}"]`).join(',') + `{${style}}`)
  const marked = (status: ProgressStatus): string[] => Object.keys(progress).filter((id) => progress[id] === status)
  const css = [
    ...(Object.keys(PROGRESS_LOOK) as ProgressStatus[]).map((status) => rule(marked(status), PROGRESS_LOOK[status])),
    rule(changed, 'outline:2px dashed var(--nessa-attention);outline-offset:3px'),
    rule(lit, 'outline:2px solid var(--ring);outline-offset:3px;box-shadow:0 0 0 6px color-mix(in oklab,var(--ring) 20%,transparent)')
  ].join('')
  return css ? <style>{css}</style> : null
}

export interface BoardOnCanvasProps {
  board: Board
  state: PlanState
  view: BoardView
  selectedBox?: string
  onSelectBox: (boxId: string) => void
  /** Double-clicking a box: into its detail board. */
  onOpenBox: (boxId: string) => void
  /** The title: what the board says, in the sidebar. */
  onOpenDetails: () => void
  /** Boxes lit from outside — a hovered paragraph, a walk-through step. */
  lit: readonly string[]
  /** The board whose details are open, drawn as the one being read. */
  reading: boolean
}

/** A board on the whiteboard: its title, a few signs of what is going on, and the picture, unframed. */
export function BoardOnCanvas({ board, state, view, selectedBox, onSelectBox, onOpenBox, onOpenDetails, lit, reading }: BoardOnCanvasProps): React.JSX.Element {
  const { index, shown } = shownOf(board, view)
  const drawing = boardDrawing(shown, view.today)
  const open = decisionsOn(state, board.id).filter((decision) => !decision.answer).length
  const via = viaOf(state, board)
  return (
    <article data-board-id={board.id} onDoubleClick={onBox(onOpenBox)} className="flex w-max flex-col gap-2">
      <Spotlight boardId={board.id} lit={lit} changed={index > 0 && !view.today ? shown.changed : []} progress={view.today ? {} : progressOn(state, board.id)} />
      <button
        type="button"
        onClick={onOpenDetails}
        aria-pressed={reading}
        title="Read about this board — or drag to move it"
        // Like a window's title bar: a click reads about the board, a drag moves it.
        data-workflow-canvas-drag-through=""
        className={cn('flex max-w-[60ch] cursor-grab items-baseline gap-2 self-start rounded-lg px-2 py-1 text-left hover:bg-accent/60 active:cursor-grabbing', reading && 'bg-accent/70')}
      >
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{KIND_LABEL[drawing.type]}</span>
        <span className="text-lg leading-snug font-semibold">{shown.title}</span>
        {via ? <span className="shrink-0 text-xs text-muted-foreground">inside {via}</span> : null}
        {view.today ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Today</span> : null}
        {board.versions.length > 1 ? <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">v{index + 1}</span> : null}
        {open > 0 ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-nessa-attention/15 px-2 py-0.5 text-[11px] font-medium text-foreground [&_svg]:size-3">
            <Scale aria-hidden="true" /> {open} to decide
          </span>
        ) : null}
      </button>
      <BoardDrawing drawing={drawing} selectedId={selectedBox} onSelect={onSelectBox} lines={view.today ? {} : boxLines(state, board.id)} bare />
    </article>
  )
}

/** Older versions stay one click away. */
function VersionStepper({ count, index, onVersion }: { count: number; index: number; onVersion: (index: number) => void }): React.JSX.Element | null {
  if (count < 2) return null
  return (
    <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums">
      <IconButton label="Previous version" onClick={() => onVersion(index - 1)} disabled={index === 0}>
        <ChevronLeft />
      </IconButton>
      <span>
        v{index + 1} of {count}
      </span>
      <IconButton label="Next version" onClick={() => onVersion(index + 1)} disabled={index === count - 1}>
        <ChevronRight />
      </IconButton>
    </span>
  )
}

/** The story, a paragraph at a time: hovering one lights up the boxes it talks about on the board. */
function Story({ text, nodes, onHover }: { text: string; nodes: readonly GraphNode[]; onHover: (ids: string[]) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-foreground/90" onMouseLeave={() => onHover([])}>
      {text.split(/\n\s*\n/).map((paragraph, at) => (
        <div key={at} onMouseEnter={() => onHover(mentionedBoxes(paragraph, nodes))} className="-mx-1.5 rounded-md px-1.5 hover:bg-accent/40">
          <MessageMarkdown>{paragraph}</MessageMarkdown>
        </div>
      ))}
    </div>
  )
}

export interface BoardDetailsProps {
  board: Board
  state: PlanState
  view: BoardView
  onView: (view: BoardView) => void
  /** Sends the reader's choices on this board's decisions. */
  onDecide: (choices: Choice[]) => boolean
  /** The boxes a hovered paragraph talks about, to light up on the board. */
  onHover: (ids: string[]) => void
  onOpenParent?: () => void
  /** Opens the board in a panel of its own; absent where it already is one. */
  onOpenBeside?: () => void
}

/** Everything to read about a board: what it shows and why, today against after, its versions, and the decisions it asks for. */
export function BoardDetails({ board, state, view, onView, onDecide, onHover, onOpenParent, onOpenBeside }: BoardDetailsProps): React.JSX.Element {
  const { index, shown } = shownOf(board, view)
  const via = viaOf(state, board)
  const decisions = decisionsOn(state, board.id)
  const changed = shown.changed.map((id) => shown.graph.nodes.find((node) => node.id === id)?.label ?? id)
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {KIND_LABEL[boardDrawing(shown).type]}
            {via && onOpenParent ? (
              <button type="button" onClick={onOpenParent} className="flex items-center gap-1 normal-case tracking-normal hover:text-foreground">
                <CornerLeftUp className="size-3" aria-hidden="true" /> inside {via}
              </button>
            ) : null}
          </p>
          <h3 className="mt-0.5 text-base leading-snug font-semibold">{shown.title}</h3>
          {changed.length > 0 && index > 0 ? <p className="mt-0.5 text-xs text-muted-foreground">Changed in this version (outlined): {changed.join(', ')}</p> : null}
        </div>
        {onOpenBeside ? (
          <IconButton label="Open beside" onClick={onOpenBeside}>
            <PanelRightOpen />
          </IconButton>
        ) : null}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {shown.before ? (
          <SegmentedControl value={view.today ? 'today' : 'after'} onValueChange={(value) => onView({ ...view, today: value === 'today' })} aria-label="Which picture">
            <SegmentedControlOption value="today">Today</SegmentedControlOption>
            <SegmentedControlOption value="after">After the change</SegmentedControlOption>
          </SegmentedControl>
        ) : (
          <span />
        )}
        <VersionStepper count={board.versions.length} index={index} onVersion={(version) => onView({ ...view, version })} />
      </div>
      <Story text={shown.story} nodes={[...shown.graph.nodes, ...(shown.before?.nodes ?? [])]} onHover={onHover} />
      {decisions.length > 0 ? <DecisionDeck decisions={decisions} onSend={onDecide} /> : null}
    </div>
  )
}

/** A board read on its own, in a panel opened beside the whiteboard: its details, then the picture, framed. */
export function BoardSheet({
  board,
  state,
  onDecide,
  selectedBox,
  onSelectBox,
  onOpenBox,
  onOpenParent
}: {
  board: Board
  state: PlanState
  onDecide: (choices: Choice[]) => boolean
  selectedBox?: string
  onSelectBox: (boxId: string) => void
  onOpenBox: (boxId: string) => void
  onOpenParent?: () => void
}): React.JSX.Element {
  const [view, setView] = useState<BoardView>(NEW_VIEW)
  const [lit, setLit] = useState<string[]>([])
  const { index, shown } = shownOf(board, view)
  return (
    <article data-board-id={board.id} onDoubleClick={onBox(onOpenBox)} className="flex flex-col gap-4">
      <Spotlight boardId={board.id} lit={lit} changed={index > 0 && !view.today ? shown.changed : []} progress={view.today ? {} : progressOn(state, board.id)} />
      <BoardDetails board={board} state={state} view={view} onView={setView} onDecide={onDecide} onHover={setLit} onOpenParent={onOpenParent} />
      <BoardDrawing drawing={boardDrawing(shown, view.today)} selectedId={selectedBox} onSelect={onSelectBox} lines={view.today ? {} : boxLines(state, board.id)} />
    </article>
  )
}
