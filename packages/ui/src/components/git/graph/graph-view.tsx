import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

import type { DiffSpec, ReviewComment, ReviewGraph } from '@canopy/shared'

import { FileRefLinks, type OpenFileRef } from '@/components/agent/answer-links'
import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import type { DiffMode } from '@/components/worktree-diff'
import { useDiffFiles } from '@/lib/api-hooks'
import { isReviewed, isStale, reviewedKey, tourSteps, type NodeCard, type TourStep } from '@/lib/review-graph'
import type { ReviewGraphState } from '@/lib/use-review-graph'
import { useHotkeys } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'

import { GraphBar, type CommitRange } from './graph-bar'
import { GraphCards, GraphLayered, type Depth } from './graph-map'
import { TourStepView } from './graph-tour'

type View = 'cards' | 'layered' | 'tour'

/** The stops of the tour in a menu, ticked ones marked, indented by depth. */
function StopMenu({ steps, at, onGo, reviewed }: { steps: TourStep[]; at: number; onGo: (index: number) => void; reviewed: ReadonlySet<string> }): React.JSX.Element | null {
  const step = steps[at]
  if (!step) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 min-w-0 gap-1.5 px-2 text-xs">
          <span className="truncate">{step.node.title}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
        {steps.map((item, index) => (
          <DropdownMenuItem key={item.node.id} onSelect={() => onGo(index)} className={cn('gap-2 text-xs', index === at && 'bg-accent', !item.reviewable && 'text-muted-foreground')}>
            <span className="min-w-0 flex-1 truncate" style={{ paddingLeft: `${item.trail.length * 0.75}rem` }}>
              {item.node.title}
            </span>
            {isReviewed(reviewed, item.node) ? <span aria-label="Reviewed">✓</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One graph: as cards, in tiers, or walked stop by stop. */
function GraphReview({
  worktreeId,
  spec,
  graph,
  state,
  comments,
  mode
}: {
  worktreeId: string
  spec: DiffSpec
  graph: ReviewGraph
  state: ReviewGraphState
  comments: ReviewComment[]
  mode: DiffMode
}): React.JSX.Element {
  const snapshot = useDiffFiles(worktreeId, spec).data
  const files = useMemo(() => (snapshot && 'files' in snapshot ? snapshot.files : []), [snapshot])
  const steps = useMemo(() => tourSteps(graph), [graph])
  const indexOf = useMemo(() => new Map(steps.map((step, index) => [step.node.id, index])), [steps])

  const [view, setView] = useState<View>('cards')
  const [current, setCurrent] = useState(0)
  const [at, setAt] = useState<string>()
  const [depth, setDepth] = useState<Depth>('top')
  // A new graph starts over at its cards.
  useEffect(() => {
    setView('cards')
    setCurrent(0)
    setAt(undefined)
  }, [graph])

  const go = (index: number): void => setCurrent(Math.max(0, Math.min(steps.length - 1, index)))
  const index = Math.min(current, Math.max(0, steps.length - 1))
  const step = steps[index]
  const tick = (on: boolean): void => {
    if (step?.reviewable) state.setReviewed(reviewedKey(step.node.refs), on)
  }
  const next = (): void => {
    tick(true)
    go(index + 1)
  }
  const tour = (card: Pick<NodeCard, 'first'>): void => {
    go(card.first)
    setView('tour')
  }
  const jump = (id: string): void => {
    const found = indexOf.get(id)
    if (found !== undefined) go(found)
  }
  useHotkeys(view === 'tour' ? { '[': () => go(index - 1), ']': () => go(index + 1), n: next } : {})

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <SegmentedControl value={view} onValueChange={(value) => setView(value as View)} aria-label="Graph view" className="text-xs">
          <SegmentedControlOption value="cards">Cards</SegmentedControlOption>
          <SegmentedControlOption value="layered">Layered</SegmentedControlOption>
          <SegmentedControlOption value="tour">Guided tour</SegmentedControlOption>
        </SegmentedControl>
        {view === 'tour' ? (
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <StopMenu steps={steps} at={index} onGo={go} reviewed={state.reviewed} />
          </div>
        ) : null}
      </div>
      {view === 'tour' && step ? (
        <TourStepView
          key={step.node.id}
          worktreeId={worktreeId}
          spec={spec}
          graph={graph}
          step={step}
          index={index}
          total={steps.length}
          files={files}
          reviewed={isReviewed(state.reviewed, step.node)}
          onReviewed={tick}
          onBack={index > 0 ? () => go(index - 1) : undefined}
          onSkip={index < steps.length - 1 ? () => go(index + 1) : undefined}
          onNext={next}
          onJump={jump}
          comments={comments}
          mode={mode}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === 'layered' ? (
            <GraphLayered graph={graph} files={files} reviewed={state.reviewed} depth={depth} onDepth={setDepth} current={step?.node.id} onTour={tour} />
          ) : (
            <GraphCards graph={graph} files={files} reviewed={state.reviewed} at={at} onAt={setAt} current={step?.node.id} onTour={tour} />
          )}
        </div>
      )}
    </>
  )
}

/**
 * Graph: the change drawn by an agent as typed nodes and the edges between them — its features,
 * its concepts, its tasks, how data flows through it — for whichever change is picked: what is
 * uncommitted, the whole branch, a run of commits, or the pull request. It reads as cards a level
 * at a time, as tiers along its edges, or as a guided tour that walks it top-down, one stop at a
 * time, each showing only its share of the code.
 */
export function GraphView({
  worktreeId,
  state,
  range,
  prHead,
  onPickCommits,
  comments,
  mode,
  onOpenRef
}: {
  worktreeId: string
  state: ReviewGraphState
  range?: CommitRange
  /** The open pull request's head, when there is one: it enables the PR scope and tells a PR graph it is old. */
  prHead?: string
  onPickCommits: () => void
  comments: ReviewComment[]
  mode: DiffMode
  onOpenRef: OpenFileRef
}): React.JSX.Element {
  const { result, spec, record } = state
  const steps = useMemo(() => (result ? tourSteps(result) : []), [result])
  const reviewable = steps.filter((step) => step.reviewable)
  const done = reviewable.filter((step) => isReviewed(state.reviewed, step.node)).length
  const liveKind = record?.scope.kind === 'branch' ? 'base' : 'head'
  const live = useDiffFiles(worktreeId, { kind: 'worktree', against: liveKind }).data
  const stale = record !== undefined && result !== undefined && isStale(record, result, { files: live && 'files' in live ? live.files : undefined, prHead })

  return (
    <FileRefLinks onOpen={onOpenRef}>
      <div className="flex min-h-0 flex-1 flex-col">
        <GraphBar
          key={`${worktreeId}:${record?.id ?? 'none'}:${range ? `${range.from}..${range.to}` : ''}`}
          state={state}
          range={range}
          hasPr={prHead !== undefined}
          onPickCommits={onPickCommits}
          done={done}
          total={reviewable.length}
          stale={stale}
        />
        {state.error ? (
          <div className="px-4 pt-3">
            <ErrorNote error={state.error} />
          </div>
        ) : null}
        {result && spec && steps.length > 0 ? (
          <GraphReview worktreeId={worktreeId} spec={spec} graph={result} state={state} comments={comments} mode={mode} />
        ) : (
          <div className="mx-auto flex max-w-md flex-col gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{state.running ? 'The Git Agent is reading the change…' : 'Review the change as a graph'}</p>
            <p>
              {state.running
                ? 'Follow along in its Git Agent tab. The graph appears here as soon as it answers, and asking it there to merge or split nodes redraws it.'
                : 'Pick which change — what is uncommitted, the whole branch, a run of commits or the pull request — and what to draw it as. An agent splits it into nodes, every hunk in exactly one, and links them. Read it as cards or in tiers, or take the guided tour and press Next until you are done.'}
            </p>
          </div>
        )}
      </div>
    </FileRefLinks>
  )
}
