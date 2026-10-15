import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dagre from '@dagrejs/dagre'
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { CONTAINS, type ReviewGraph } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { neighbourhood, networkOf, ownerOf, SHAPE_RELATIONS, type NetNode, type NetNodeKind, type NetState, type Network } from '@/lib/graph-network'
import { edgeWords } from '@/lib/review-graph'
import { useStoredState } from '@/lib/local-store'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

/**
 * The graph as a living network. Flat: a force simulation where each depth holds to its own ring —
 * the whole change at the centre, atoms outermost — so nesting is the shape while related nodes
 * still pull together and a commit several nodes share becomes a hub; drag a dot and the rest
 * settle round it. Hierarchical: the same graph as a strict top-down tree.
 */

export type NetworkLayout = 'flat' | 'hierarchical'

const NODE_R = [22, 15, 11, 9, 8] as const
const ATOM_R: Record<Exclude<NetNodeKind, 'root' | 'node'>, number> = { hunk: 5, test: 5, commit: 6 }
const radiusOf = (dot: NetNode): number => (dot.kind === 'root' || dot.kind === 'node' ? (NODE_R[Math.min(dot.level, NODE_R.length - 1)] ?? 8) : ATOM_R[dot.kind])
const RING = 120
const WARM_TICKS = 220

const STATE_FILL: Record<NetState, string> = {
  reviewed: 'var(--nessa-diff-addition)',
  unreviewed: 'var(--nessa-diff-modification, #d29922)',
  intro: 'var(--muted-foreground)'
}
const ATOM_FILL: Record<Exclude<NetNodeKind, 'root' | 'node'>, string> = { hunk: '#818cf8', test: '#34d399', commit: '#38bdf8' }
export type ColourBy = 'review' | 'change'

const ADD = 'var(--nessa-diff-addition)'
const DEL = 'var(--nessa-diff-deletion)'

/** A node's added share as a pie, green then red, so the split reads at a glance. */
const changeFill = (dot: NetNode): string => {
  const all = (dot.added ?? 0) + (dot.removed ?? 0)
  if (all === 0) return 'var(--muted-foreground)'
  const share = Math.round(((dot.added ?? 0) / all) * 100)
  return `conic-gradient(${ADD} 0 ${share}%, ${DEL} ${share}% 100%)`
}

const fillOf = (dot: NetNode, by: ColourBy = 'review'): string =>
  dot.kind === 'root' ? 'var(--foreground)' : dot.kind === 'node' ? (by === 'change' ? changeFill(dot) : STATE_FILL[dot.state ?? 'intro']) : ATOM_FILL[dot.kind]

const SHAPE_STYLE: Record<string, { stroke: string; dash?: string; width: number }> = {
  [CONTAINS]: { stroke: 'var(--muted-foreground)', width: 1.4 },
  owns: { stroke: '#818cf8', width: 1 },
  'tested-by': { stroke: '#34d399', width: 1.2 },
  'arrived-in': { stroke: '#38bdf8', width: 0.8 }
}
const SIDEWAYS = { stroke: '#f59e0b', width: 1.5 }
const styleOf = (relation: string) => SHAPE_STYLE[relation] ?? SIDEWAYS

const LINK: Record<string, { distance: number; strength: number }> = {
  [CONTAINS]: { distance: 70, strength: 0.7 },
  owns: { distance: 26, strength: 0.8 },
  'tested-by': { distance: 28, strength: 0.8 },
  'arrived-in': { distance: 40, strength: 0.3 }
}
const linkOf = (relation: string) => LINK[relation] ?? { distance: 140, strength: 0.06 }

type XY = { x: number; y: number }
type SimNode = SimulationNodeDatum & { id: string; r: number; kind: NetNodeKind; level: number }
type SimLink = SimulationLinkDatum<SimNode> & { relation: string }

function tree(network: Network): Map<string, XY> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 18, ranksep: 70, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const dot of network.nodes) {
    const r = radiusOf(dot)
    const labelled = dot.kind === 'root' || dot.kind === 'node'
    g.setNode(dot.id, { width: labelled ? 150 : r * 2 + 8, height: r * 2 + (labelled ? 28 : 8) })
  }
  // Only the shape lays out the tree; sideways edges are drawn over it.
  for (const e of network.edges) if (SHAPE_RELATIONS.has(e.relation)) g.setEdge(e.source, e.target)
  dagre.layout(g)
  const out = new Map<string, XY>()
  for (const dot of network.nodes) {
    const p = g.node(dot.id)
    const r = radiusOf(dot)
    if (p) out.set(dot.id, { x: p.x - r, y: p.y - r })
  }
  return out
}

interface DotData extends Record<string, unknown> {
  dot: NetNode
  by: ColourBy
  dimmed: boolean
  picked: boolean
}

const CENTER = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' } as const

function Dot({ data }: NodeProps<Node<DotData>>): React.JSX.Element {
  const { dot, by, dimmed, picked } = data
  const r = radiusOf(dot)
  const labelled = dot.kind === 'root' || dot.kind === 'node' || dot.kind === 'commit' || dot.kind === 'test'
  return (
    <div className={cn('relative transition-opacity duration-150', dimmed && 'opacity-15')} title={[dot.node?.summary ?? dot.path ?? dot.sha ?? dot.label, dot.added !== undefined ? `+${dot.added} −${dot.removed}` : ''].filter(Boolean).join('\n')}>
      <Handle type="target" position={Position.Top} style={CENTER} className="opacity-0!" />
      <Handle type="source" position={Position.Top} style={CENTER} className="opacity-0!" />
      <div
        className={cn('rounded-full border-2 border-background shadow-sm', dot.state === 'intro' && 'border-dashed! border-muted-foreground!', picked && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}
        style={{ width: r * 2, height: r * 2, background: fillOf(dot, by) }}
      />
      {labelled ? (
        <span
          className={cn(
            'pointer-events-none absolute top-full left-1/2 mt-0.5 w-max -translate-x-1/2 truncate text-center text-muted-foreground',
            dot.kind === 'root' || dot.level === 1 ? 'max-w-56 text-[11px] font-medium text-foreground' : dot.kind === 'node' ? 'max-w-40 text-[10px]' : 'max-w-28 font-mono text-[9px]'
          )}
        >
          {dot.label}
        </span>
      ) : null}
    </div>
  )
}

const nodeTypes = { dot: Dot }

function NetworkCanvas({ network, layout, by, picked, onOpen }: { network: Network; layout: NetworkLayout; by: ColourBy; picked?: string; onOpen: (id: string) => void }): React.JSX.Element {
  const { theme } = useTheme()
  const [hovered, setHovered] = useState<string>()
  const lit = useMemo(() => (hovered ? neighbourhood(network, hovered) : undefined), [network, hovered])

  const sim = useRef<Simulation<SimNode, SimLink> | null>(null)
  const simNodes = useRef<SimNode[]>([])
  const [positions, setPositions] = useState<Map<string, XY>>(() => new Map())
  const frame = useRef<number | null>(null)
  const skip = useRef(false)

  useEffect(() => {
    if (layout === 'hierarchical') {
      sim.current?.stop()
      sim.current = null
      setPositions(tree(network))
      return
    }
    const nodes: SimNode[] = network.nodes.map((dot) => {
      const angle = Math.random() * Math.PI * 2
      const ring = dot.level * RING
      return { id: dot.id, r: radiusOf(dot), kind: dot.kind, level: dot.level, x: Math.cos(angle) * ring, y: Math.sin(angle) * ring }
    })
    const links: SimLink[] = network.edges.map((e) => ({ source: e.source, target: e.target, relation: e.relation }))
    const simulation = forceSimulation<SimNode, SimLink>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => linkOf(l.relation).distance)
          .strength((l) => linkOf(l.relation).strength)
      )
      .force('charge', forceManyBody<SimNode>().strength((d) => (d.kind === 'node' || d.kind === 'root' ? -140 - 60 * Math.max(0, 3 - d.level) : -24)))
      .force('collide', forceCollide<SimNode>((d) => d.r + (d.kind === 'node' ? 16 : 4)).strength(0.9))
      .force('ring', forceRadial<SimNode>((d) => d.level * RING, 0, 0).strength((d) => (d.kind === 'node' ? 0.55 : 0.25)))
      .force('x', forceX<SimNode>(0).strength(0.015))
      .force('y', forceY<SimNode>(0).strength(0.015))
      .alphaDecay(0.025)
      .velocityDecay(0.4)
      .stop()
    const root = nodes.find((n) => n.kind === 'root')
    if (root) {
      root.fx = 0
      root.fy = 0
    }
    const snapshot = (): Map<string, XY> => new Map(nodes.map((n) => [n.id, { x: (n.x ?? 0) - n.r, y: (n.y ?? 0) - n.r }]))
    for (let i = 0; i < WARM_TICKS; i++) simulation.tick()
    setPositions(snapshot())
    simulation.on('tick', () => {
      skip.current = !skip.current
      if (skip.current || frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        setPositions(snapshot())
      })
    })
    simulation.restart()
    sim.current = simulation
    simNodes.current = nodes
    return () => {
      simulation.stop()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      sim.current = null
    }
  }, [network, layout])

  const pin = (id: string, at: XY): void => {
    const n = simNodes.current.find((candidate) => candidate.id === id)
    if (!n) return
    n.fx = at.x + n.r
    n.fy = at.y + n.r
  }

  const nodes: Node<DotData>[] = useMemo(
    () =>
      network.nodes.map((dot) => {
        const r = radiusOf(dot)
        return {
          id: dot.id,
          type: 'dot',
          position: positions.get(dot.id) ?? { x: 0, y: 0 },
          width: r * 2,
          height: r * 2,
          draggable: layout === 'flat',
          data: { dot, by, dimmed: lit !== undefined && !lit.has(dot.id), picked: dot.id === picked }
        }
      }),
    [network, positions, lit, picked, layout, by]
  )

  const edges: Edge[] = useMemo(
    () =>
      network.edges.map((e) => {
        const style = styleOf(e.relation)
        const touches = lit === undefined || (lit.has(e.source) && lit.has(e.target))
        const sideways = !SHAPE_RELATIONS.has(e.relation)
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: layout === 'flat' ? 'straight' : 'default',
          label: sideways && lit !== undefined && touches ? edgeWords(e.relation) : undefined,
          labelStyle: { fontSize: 9, fill: style.stroke },
          labelBgStyle: { fill: 'var(--card)' },
          style: { stroke: style.stroke, strokeWidth: style.width, strokeDasharray: 'dash' in style ? style.dash : undefined, opacity: touches ? 0.9 : 0.06 }
        }
      }),
    [network, lit, layout]
  )

  const onDragStart = useCallback((_: unknown, node: Node) => {
    pin(node.id, node.position)
    sim.current?.alphaTarget(0.25).restart()
  }, [])
  const onDrag = useCallback((_: unknown, node: Node) => pin(node.id, node.position), [])
  const onDragStop = useCallback((_: unknown, node: Node) => {
    const n = simNodes.current.find((candidate) => candidate.id === node.id)
    if (n && n.kind !== 'root') {
      n.fx = null
      n.fy = null
    }
    sim.current?.alphaTarget(0)
  }, [])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme}
      fitView
      fitViewOptions={{ padding: 0.12, minZoom: 0.25, maxZoom: 1.4 }}
      minZoom={0.1}
      maxZoom={3}
      nodesConnectable={false}
      elementsSelectable={false}
      onNodeMouseEnter={(_, n) => setHovered(n.id)}
      onNodeMouseLeave={() => setHovered(undefined)}
      onNodeDragStart={onDragStart}
      onNodeDrag={onDrag}
      onNodeDragStop={onDragStop}
      onNodeClick={(_, n) => {
        const owner = ownerOf(network, n.id)
        if (owner) onOpen(owner)
      }}
      proOptions={{ hideAttribution: true }}
      className="bg-background"
    >
      <Background gap={18} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => { const d = n.data as DotData; return by === 'change' && d.dot.kind === 'node' ? ((d.dot.added ?? 0) >= (d.dot.removed ?? 0) ? ADD : DEL) : fillOf(d.dot) }} />
    </ReactFlow>
  )
}

function Legend({ by }: { by: ColourBy }): React.JSX.Element {
  const dot = (fill: string, extra?: string) => <span className={cn('inline-block size-2.5 rounded-full', extra)} style={{ background: fill }} />
  return (
    <div className="pointer-events-none absolute top-2 left-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur">
      {by === 'change' ? (
        <>
          <span className="flex items-center gap-1">{dot(ADD)} lines added</span>
          <span className="flex items-center gap-1">{dot(DEL)} lines removed</span>
          <span className="flex items-center gap-1">{dot(`conic-gradient(${ADD} 0 60%, ${DEL} 60% 100%)`)} the split</span>
        </>
      ) : (
        <>
          <span className="flex items-center gap-1">{dot(STATE_FILL.unreviewed)} to review</span>
          <span className="flex items-center gap-1">{dot(STATE_FILL.reviewed)} reviewed</span>
          <span className="flex items-center gap-1">{dot('transparent', 'border border-dashed border-muted-foreground')} group</span>
        </>
      )}
      <span className="text-border">|</span>
      <span className="flex items-center gap-1">{dot(ATOM_FILL.hunk)} hunk</span>
      <span className="flex items-center gap-1">{dot(ATOM_FILL.test)} test</span>
      <span className="flex items-center gap-1">{dot(ATOM_FILL.commit)} commit</span>
      <span className="text-border">|</span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-0.5 w-3" style={{ background: SIDEWAYS.stroke }} /> relates to
      </span>
    </div>
  )
}

/**
 * The Network view: Flat or Hierarchical, with or without the hunks and commits under each node.
 * Hover a dot to light what it touches; click one to open its stop on the guided tour.
 */
export function GraphNetwork({
  graph,
  reviewed,
  lines,
  layout,
  onLayout,
  current,
  onOpen
}: {
  graph: ReviewGraph
  reviewed: ReadonlySet<string>
  /** Lines each hunk adds and removes, by `lineKey`. */
  lines: Readonly<Record<string, [number, number]>>
  layout: NetworkLayout
  onLayout: (layout: NetworkLayout) => void
  current?: string
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [atoms, setAtoms] = useStoredState('canopy-graph-network-atoms', false, (v): v is boolean => typeof v === 'boolean')
  const [by, setBy] = useStoredState<ColourBy>('canopy-graph-network-colour', 'review', (v): v is ColourBy => v === 'review' || v === 'change')
  const counted = Object.keys(lines).length > 0
  const network = useMemo(() => networkOf(graph, reviewed, { atoms, lines }), [graph, reviewed, atoms, lines])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-4 py-1.5 text-xs">
        <Button size="sm" variant={layout === 'flat' ? 'secondary' : 'ghost'} className="h-7 text-xs" onClick={() => onLayout('flat')}>
          Flat
        </Button>
        <Button size="sm" variant={layout === 'hierarchical' ? 'secondary' : 'ghost'} className="h-7 text-xs" onClick={() => onLayout('hierarchical')}>
          Hierarchical
        </Button>
        <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={atoms} onChange={() => setAtoms(!atoms)} className="size-3.5" />
          Hunks and commits
        </label>
        <span className="ml-3 text-muted-foreground">Colour by</span>
        <Button size="sm" variant={by === 'review' ? 'secondary' : 'ghost'} className="h-7 text-xs" onClick={() => setBy('review')}>
          Review
        </Button>
        <Button
          size="sm"
          variant={by === 'change' ? 'secondary' : 'ghost'}
          className="h-7 text-xs"
          disabled={!counted}
          title={counted ? 'Green for lines added, red for lines removed' : 'This graph was made before line counts were kept; make a new one to see them'}
          onClick={() => setBy('change')}
        >
          Added / removed
        </Button>
        <span className="ml-auto text-muted-foreground">Hover to light what a node touches; click to review it.</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <Legend by={counted ? by : 'review'} />
        {/* Keyed so a new layout or a new set of dots opens fitted to the view, not where the last one left the camera. */}
        <NetworkCanvas key={`${layout}:${atoms}`} network={network} layout={layout} by={counted ? by : 'review'} picked={current} onOpen={onOpen} />
      </div>
    </div>
  )
}
