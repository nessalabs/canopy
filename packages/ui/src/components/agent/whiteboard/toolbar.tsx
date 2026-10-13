import { FileText, Footprints, History, Maximize, Minus, Plus, Send } from 'lucide-react'

import type { PlanState, WhiteboardMode } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { boardOutline, MODE_WORD, progressSummary } from '@/lib/whiteboard'
import { cn } from '@/lib/utils'

import { IconButton } from './icon-button'

/** A labelled action in the strip: icon and words, pressed while its drawer is open. */
const Action = ({ icon, label, pressed, onClick, emphasis }: { icon: React.ReactNode; label: string; pressed?: boolean; onClick: () => void; emphasis?: boolean }): React.JSX.Element => (
  <Button variant={emphasis ? 'default' : 'ghost'} size="sm" aria-pressed={pressed} onClick={onClick} className={cn('h-7 gap-1.5 px-2 text-xs [&_svg]:size-3.5', pressed && 'bg-accent text-foreground')}>
    {icon}
    {label}
  </Button>
)

const money = (usd: number): string => `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`

/**
 * Tabs for the boards, in reading order, once there is more than one: where you are, and one click
 * to any other. A detail board is named with the box it opens.
 */
function BoardTabs({ state, current, onFocus }: { state: PlanState; current?: string; onFocus: (board: string) => void }): React.JSX.Element | null {
  const outline = boardOutline(state)
  if (outline.length < 2) return null
  return (
    <nav aria-label="Boards" className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
      {outline.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-current={entry.id === current ? 'true' : undefined}
          onClick={() => onFocus(entry.id)}
          title={entry.via ? `${entry.title} — inside ${entry.via}` : entry.title}
          className={cn(
            'flex max-w-56 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
            entry.id === current && 'bg-accent font-medium text-foreground'
          )}
        >
          {entry.depth > 0 ? <span aria-hidden="true">{'›'.repeat(entry.depth)}</span> : null}
          <span className="truncate">{entry.title}</span>
        </button>
      ))}
    </nav>
  )
}

export interface ToolbarProps {
  state: PlanState
  mode?: WhiteboardMode
  busy: boolean
  cost?: number
  /** The board in view, for the tabs. */
  current?: string
  /** The open drawer, so its button shows pressed. */
  drawer?: string
  hasPlan: boolean
  /** The plan waits for approval, its card put away: the Plan button is the way back to it. */
  planWaiting?: boolean
  notes: number
  onFocus: (board: string) => void
  onTour: () => void
  onPlan: () => void
  onTrail: () => void
  onSendNotes: () => void
  onZoom: (factor: number) => void
  onFit: () => void
}

/**
 * The strip over the canvas: what the agent is doing and how far a build has got; the walk-through,
 * the plan document, the decision trail and the reader's notes; the view controls; and, under it,
 * a tab per board.
 */
export function Toolbar({ state, mode, busy, cost, current, drawer, hasPlan, planWaiting, notes, onFocus, onTour, onPlan, onTrail, onSendNotes, onZoom, onFit }: ToolbarProps): React.JSX.Element {
  const { done, doing } = progressSummary(state)
  const boards = state.order.length
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-medium">
          <StatusDot status={busy ? 'running' : 'idle'} />
          {mode ? MODE_WORD[mode] : 'Whiteboard'}
        </span>
        {done + doing > 0 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
            {done} done{doing ? ` · ${doing} in progress` : ''}
          </span>
        ) : null}
        <span className="flex-1" />
        {boards > 0 ? (
          <>
            <Action icon={<Footprints />} label="Walk me through" onClick={onTour} />
            {hasPlan ? <Action icon={<FileText />} label={planWaiting ? 'Review plan' : 'Plan'} onClick={onPlan} emphasis={planWaiting} /> : null}
            <Action icon={<History />} label="Decisions" pressed={drawer === 'trail'} onClick={onTrail} />
            {notes > 0 ? <Action icon={<Send />} label={`Send ${notes} ${notes === 1 ? 'note' : 'notes'}`} onClick={onSendNotes} emphasis /> : null}
            <span className="hidden text-[11px] text-muted-foreground tabular-nums xl:inline" title="Boards, drawings and what the session has cost">
              {boards} {boards === 1 ? 'board' : 'boards'} · {state.drawings} {state.drawings === 1 ? 'drawing' : 'drawings'}
              {cost !== undefined ? ` · ${money(cost)}` : ''}
            </span>
            <span className="flex items-center">
              <IconButton label="Zoom out" onClick={() => onZoom(1 / 1.2)}>
                <Minus />
              </IconButton>
              <IconButton label="Zoom in" onClick={() => onZoom(1.2)}>
                <Plus />
              </IconButton>
              <IconButton label="Fit every board" onClick={onFit}>
                <Maximize />
              </IconButton>
            </span>
          </>
        ) : null}
      </div>
      <BoardTabs state={state} current={current} onFocus={onFocus} />
    </div>
  )
}
