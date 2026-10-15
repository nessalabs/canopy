import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronRight, CornerDownRight, SkipForward } from 'lucide-react'

import { CONTAINS, type ChangedFile, type DiffSpec, type ReviewEdge, type ReviewGraph, type ReviewComment } from '@canopy/shared'

import { LinkedMarkdown } from '@/components/agent/answer-links'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { DiffMode } from '@/components/worktree-diff'
import { useFilePatches } from '@/lib/api-hooks'
import { slicePatch } from '@/lib/patch'
import { edgeWords, nodeFiles, type TourStep } from '@/lib/review-graph'
import { cn } from '@/lib/utils'

import { ContentPane } from '../content-pane'

/** A file's stub for the content pane when the diff list no longer has it (the graph is older than the diff). */
const stub = (path: string): ChangedFile => ({ path, status: 'M', additions: 0, deletions: 0, binary: false, staged: 'unstaged', conflicted: false, headSha: null }) as ChangedFile

/** The step's sideways edges, both ways, as chips that jump to the node at the other end. */
function Related({ graph, id, onJump }: { graph: ReviewGraph; id: string; onJump: (id: string) => void }): React.JSX.Element | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const sideways = graph.edges.filter((edge) => edge.kind !== CONTAINS && (edge.from === id || edge.to === id))
  if (sideways.length === 0) return null
  const chip = (edge: ReviewEdge) => {
    const out = edge.from === id
    const other = byId.get(out ? edge.to : edge.from)
    if (!other) return null
    return (
      <li key={`${edge.from}>${edge.to}:${edge.kind}`}>
        <button
          type="button"
          onClick={() => onJump(other.id)}
          title={edge.label}
          className="flex w-full items-baseline gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
        >
          <span className="shrink-0 text-muted-foreground">{out ? edgeWords(edge.kind) : `${edgeWords(edge.kind)} by`}</span>
          <span className="min-w-0 truncate font-medium">{other.title}</span>
        </button>
      </li>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Related</p>
      <ul>{sideways.map(chip)}</ul>
    </div>
  )
}

/**
 * One stop on the guided tour. The story, its place in the graph and how it relates on the left;
 * on the right one file at a time — this node's hunks of it, or the whole file — through the same
 * pane Changes uses. A stop with no code of its own introduces what is inside it.
 *
 * Next ticks the stop as reviewed and moves on; Skip moves on without ticking; Back goes back.
 */
export function TourStepView({
  worktreeId,
  spec,
  graph,
  step,
  index,
  total,
  files,
  reviewed,
  onReviewed,
  onBack,
  onSkip,
  onNext,
  onJump,
  comments,
  mode
}: {
  worktreeId: string
  spec: DiffSpec
  graph: ReviewGraph
  step: TourStep
  index: number
  total: number
  files: ChangedFile[]
  reviewed: boolean
  onReviewed: (on: boolean) => void
  /** Absent on the first stop. */
  onBack?: () => void
  /** Absent on the last stop. */
  onSkip?: () => void
  /** Ticks (when there is code to tick) and moves on; on the last stop, it only ticks. */
  onNext: () => void
  /** Goes to the stop of another node. */
  onJump: (id: string) => void
  comments: ReviewComment[]
  mode: DiffMode
}): React.JSX.Element {
  const { node, trail, children, reviewable } = step
  const own = useMemo(() => nodeFiles(node.refs), [node.refs])
  const patches = useFilePatches(worktreeId, spec, own.map((file) => file.path))
  const [picked, setPicked] = useState(0)
  const shown = own[Math.min(picked, own.length - 1)]
  const changed = shown ? (files.find((file) => file.path === shown.path) ?? stub(shown.path)) : undefined
  const last = onSkip === undefined

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border px-5 py-5">
        {trail.length > 0 ? (
          <nav aria-label="Inside" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {trail.map((up, i) => (
              <span key={up.id} className="flex items-center gap-1">
                {i > 0 ? <ChevronRight className="size-3" /> : null}
                <button type="button" className="hover:text-foreground hover:underline" onClick={() => onJump(up.id)}>
                  {up.title}
                </button>
              </span>
            ))}
          </nav>
        ) : null}
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{node.kind}</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            Stop {index + 1} of {total}
          </span>
        </div>
        <h3 className="text-base leading-snug font-semibold">{node.title}</h3>
        {node.summary ? <LinkedMarkdown className="text-sm text-muted-foreground">{node.summary}</LinkedMarkdown> : null}
        {node.layers.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {node.layers.map((layer) => (
              <Badge key={layer} variant="outline" className="font-normal text-muted-foreground">
                {layer}
              </Badge>
            ))}
          </div>
        ) : null}
        {children.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{reviewable ? 'Then, inside it' : 'Inside it, next'}</p>
            <ul>
              {children.map((child) => (
                <li key={child.id}>
                  <button type="button" onClick={() => onJump(child.id)} className="flex w-full items-baseline gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent">
                    <CornerDownRight className="size-3 shrink-0 self-center text-muted-foreground" />
                    <span className="min-w-0 truncate">{child.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Related graph={graph} id={node.id} onJump={onJump} />
        {own.length > 0 ? (
          <ul className="flex flex-col gap-0.5 pt-1" aria-label="Files at this stop">
            {own.map(({ path, hunks }, i) => {
              const patch = patches[i]?.data?.patch
              const stat = patch ? slicePatch(patch, hunks) : undefined
              return (
                <li key={path}>
                  <button
                    type="button"
                    aria-current={i === picked}
                    onClick={() => setPicked(i)}
                    title={path}
                    className={cn('flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-accent', i === picked && 'bg-accent text-foreground')}
                  >
                    <span className="min-w-0 flex-1 truncate">{path.split('/').pop()}</span>
                    {stat ? (
                      <span className="shrink-0 tabular-nums">
                        <span className="text-nessa-diff-addition">+{stat.additions}</span> <span className="text-nessa-diff-deletion">−{stat.deletions}</span>
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          {reviewable ? (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={reviewed} onChange={() => onReviewed(!reviewed)} className="size-3.5" />
              Reviewed
            </label>
          ) : null}
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" className="gap-1" disabled={!onBack} onClick={onBack} title="Back  [">
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
            <Button size="sm" variant="ghost" className="gap-1" disabled={last} onClick={onSkip} title="Skip without ticking  ]">
              <SkipForward className="size-3.5" />
              Skip
            </Button>
            <Button size="sm" className="ml-auto gap-1" onClick={onNext} disabled={last && (!reviewable || reviewed)} title="Mark reviewed and go on  n">
              {reviewable && !reviewed ? (last ? 'Mark reviewed' : 'Reviewed, next') : 'Next'}
              {last ? null : <ArrowRight className="size-3.5" />}
            </Button>
          </div>
        </div>
      </aside>
      <div className="min-h-0 min-w-0">
        {changed && shown ? (
          <ContentPane
            key={`${node.id}:${shown.path}`}
            worktreeId={worktreeId}
            spec={spec}
            file={changed}
            hunks={shown.hunks}
            comments={comments.filter((comment) => comment.file === shown.path)}
            mode={mode}
          />
        ) : (
          <div className="mx-auto flex max-w-md flex-col gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{node.title}</p>
            <p>This stop has no code of its own. It introduces the {children.length === 1 ? 'node' : `${children.length} nodes`} inside it; Next goes through them in order.</p>
          </div>
        )}
      </div>
    </div>
  )
}
