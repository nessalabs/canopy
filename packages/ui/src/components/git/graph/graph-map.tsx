import { useMemo } from 'react'
import { Check, ChevronRight, Layers } from 'lucide-react'

import { childrenOf, trailTo, type ChangedFile, type ReviewGraph, type ReviewNode } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { ChangeMap, type ChangeMapNode } from '@/components/ui/change-map'
import { cardsOf, details, edgeWords, liftEdges, type NodeCard } from '@/lib/review-graph'
import { cn } from '@/lib/utils'

/** A node's card: what it is, how much it touches, how far it is reviewed, and whether it opens a level down. */
function CardBody({ card }: { card: NodeCard }): React.JSX.Element {
  const done = card.steps > 0 && card.reviewed === card.steps
  return (
    <>
      <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{card.kind}</span>
      <span className="line-clamp-2 text-sm leading-snug font-semibold">{card.title}</span>
      <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{card.summary}</span>
      <span className="mt-auto flex items-center gap-2 pt-1 font-mono text-[10px] text-muted-foreground">
        {card.added !== undefined ? (
          <span className="tabular-nums" title={`${card.added} lines added, ${card.removed} removed`}>
            <span className="text-nessa-diff-addition">+{card.added}</span> <span className="text-nessa-diff-deletion">−{card.removed}</span>
          </span>
        ) : null}
        <span>
          {card.files} {card.files === 1 ? 'file' : 'files'} · {card.hunks} {card.hunks === 1 ? 'hunk' : 'hunks'}
          {card.inside > 0 ? ` · ${card.inside} inside` : ''}
        </span>
        <span className={cn('ml-auto flex items-center gap-1', done && 'text-foreground')}>
          {done ? <Check className="size-3" /> : null}
          {card.steps > 1 || done ? `${card.reviewed}/${card.steps}` : null}
        </span>
      </span>
    </>
  )
}

/** Card colours read as what a node mostly does to the code. */
const SHAPE_LABELS = { added: 'Mostly added', modified: 'Added and removed', deleted: 'Mostly removed' } as const

const toMapNodes = (cards: NodeCard[]): ChangeMapNode[] => cards.map((card) => ({ id: card.id, label: card.title, status: card.status, badge: card.id === 'rest' ? undefined : card.id, children: <CardBody card={card} /> }))

/** Where the cards view is: the top, or inside a node; each step back up is a button. */
function Trail({ graph, at, onGo }: { graph: Pick<ReviewGraph, 'nodes' | 'edges'>; at?: string; onGo: (id?: string) => void }): React.JSX.Element {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const trail = at ? trailTo(graph, at) : []
  return (
    <nav aria-label="Where in the graph" className="flex min-w-0 items-center gap-1 text-xs">
      <Button variant="ghost" size="sm" className={cn('h-7 px-2 text-xs', !at && 'text-foreground')} disabled={!at} onClick={() => onGo(undefined)}>
        Whole change
      </Button>
      {trail.map((id, i) => (
        <span key={id} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          <Button variant="ghost" size="sm" className="h-7 min-w-0 px-2 text-xs" disabled={i === trail.length - 1} onClick={() => onGo(id)}>
            <span className="truncate">{byId.get(id)?.title}</span>
          </Button>
        </span>
      ))}
    </nav>
  )
}

/**
 * One level of the graph as cards, in reading order, with arrows for how they relate. A card with
 * nodes inside it opens a level down; one without starts the tour there.
 */
export function GraphCards({
  graph,
  files,
  reviewed,
  lines,
  at,
  onAt,
  current,
  onTour
}: {
  graph: ReviewGraph
  files: ChangedFile[]
  reviewed: ReadonlySet<string>
  /** Lines each hunk adds and removes, by `lineKey`. */
  lines: Readonly<Record<string, [number, number]>>
  /** The node whose inside is shown; the top level when undefined. */
  at?: string
  onAt: (id?: string) => void
  current?: string
  /** Starts the tour at a card. */
  onTour: (card: NodeCard) => void
}): React.JSX.Element {
  const shown = useMemo(() => childrenOf(graph, at), [graph, at])
  const cards = useMemo(() => cardsOf(graph, shown, files, reviewed, lines), [graph, shown, files, reviewed, lines])
  const nodes = useMemo(() => toMapNodes(cards), [cards])
  const edges = useMemo(() => liftEdges(graph, shown).map(({ from, to }) => ({ from, to })), [graph, shown])
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <Trail graph={graph} at={at} onGo={onAt} />
        {at ? (
          <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" onClick={() => onTour(cardsOf(graph, [graph.nodes.find((node) => node.id === at)!], files, reviewed, lines)[0]!)}>
            Tour this
          </Button>
        ) : null}
      </div>
      <ChangeMap
        statusLabels={SHAPE_LABELS}
        title={at ? 'Inside it' : 'How the change fits together'}
        nodes={nodes}
        // Only the arrows: with a label on every one, a dozen cards read as noise. The layered view labels them.
        edges={edges}
        arrangement="grid"
        cardSize={{ width: 260, height: 148 }}
        selectedId={current}
        onSelect={(node) => {
          const card = byId.get(node.id)!
          if (card.inside > 0) onAt(card.id)
          else onTour(card)
        }}
        caption={`${edges.length > 0 ? 'Arrows show how the cards relate. ' : ''}Open a card to look inside it, or to review it when there is nothing inside.`}
      />
    </div>
  )
}

export type Depth = 'top' | 'all'

/**
 * The graph laid out in tiers along its edges, left to right, each arrow named for what it is.
 * At the top level the edges between finer nodes are lifted onto the nodes that hold them.
 */
export function GraphLayered({
  graph,
  files,
  reviewed,
  lines,
  depth,
  onDepth,
  current,
  onTour
}: {
  graph: ReviewGraph
  files: ChangedFile[]
  reviewed: ReadonlySet<string>
  /** Lines each hunk adds and removes, by `lineKey`. */
  lines: Readonly<Record<string, [number, number]>>
  depth: Depth
  onDepth: (depth: Depth) => void
  current?: string
  onTour: (card: NodeCard) => void
}): React.JSX.Element {
  const shown = useMemo<ReviewNode[]>(() => (depth === 'top' ? childrenOf(graph) : details(graph)), [graph, depth])
  const cards = useMemo(() => cardsOf(graph, shown, files, reviewed, lines), [graph, shown, files, reviewed, lines])
  const nodes = useMemo(() => toMapNodes(cards), [cards])
  const edges = useMemo(() => liftEdges(graph, shown).map(({ from, to, kind }) => ({ from, to, label: edgeWords(kind) })), [graph, shown])
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Layers className="size-3.5" />
        <Button size="sm" variant={depth === 'top' ? 'secondary' : 'ghost'} className="h-7 text-xs" onClick={() => onDepth('top')}>
          Top level
        </Button>
        <Button size="sm" variant={depth === 'all' ? 'secondary' : 'ghost'} className="h-7 text-xs" onClick={() => onDepth('all')}>
          Every detail
        </Button>
      </div>
      <ChangeMap
        statusLabels={SHAPE_LABELS}
        title="How the pieces depend on each other"
        nodes={nodes}
        edges={edges}
        arrangement="flow"
        cardSize={{ width: 240, height: 148 }}
        selectedId={current}
        onSelect={(node) => onTour(byId.get(node.id)!)}
        caption={edges.length > 0 ? 'Read each arrow from card to card: this builds on that. Open a card to review it.' : 'Nothing here leans on anything else; open a card to review it.'}
      />
    </div>
  )
}
