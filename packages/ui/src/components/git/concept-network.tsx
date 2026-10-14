import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dagre from '@dagrejs/dagre'
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { ConceptEffect } from '@canopy/shared'

import { neighbourhood, type NetEdge, type NetNode, type NetNodeKind, type NetRelation, type Network } from '@/lib/concept-network'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

/**
 * The concept map as a living network. Every concept at every depth is a dot, sized by its rung;
 * under the leaves hang the atoms the change is made of — hunks, commits, files, tests.
 *
 * Radial: a force simulation, with each rung held to its own ring — the root at the centre, atoms
 * outermost — so the hierarchy is the shape, while children still cluster round their parent and a
 * hunk or commit shared by several concepts is pulled between them into a hub. It is run to rest
 * before the first paint, so it opens coherent, and stays live after: drag a dot and the rest
 * settle round it. Layered: the same graph as a strict top-down tree, by dagre, for when a reviewer
 * wants rows rather than rings.
 */

export type NetworkLayout = 'radial' | 'layered'

/** A concept's dot shrinks with its rung; the root is the sun. */
const CONCEPT_R = [22, 15, 11, 9, 8] as const
const ATOM_R: Record<Exclude<NetNodeKind, 'concept'>, number> = { hunk: 5, test: 5, commit: 6, path: 5 }
const radiusOf = (node: NetNode): number => (node.kind === 'concept' ? (CONCEPT_R[Math.min(node.level, CONCEPT_R.length - 1)] ?? 8) : ATOM_R[node.kind])

/** How far out each rung's ring sits; atoms one ring past the deepest concept. */
const RING = 120

/** What this change did to a concept, as the dot's colour; the diff palette so it matches every other pane. */
const EFFECT_FILL: Record<ConceptEffect, string> = {
  added: 'var(--nessa-diff-addition)',
  reshaped: 'var(--nessa-diff-modification, #d29922)',
  replaced: 'var(--nessa-diff-modification, #d29922)',
  removed: 'var(--nessa-diff-deletion)',
  context: 'var(--muted-foreground)'
}
const ATOM_FILL: Record<Exclude<NetNodeKind, 'concept'>, string> = { hunk: '#818cf8', test: '#34d399', commit: '#38bdf8', path: '#94a3b8' }

const EDGE_STYLE: Record<NetRelation, { stroke: string; dash?: string; width: number }> = {
  refines: { stroke: 'var(--muted-foreground)', width: 1.4 },
  owns: { stroke: '#818cf8', width: 1 },
  cites: { stroke: '#818cf8', dash: '3 3', width: 1 },
  concerns: { stroke: '#94a3b8', dash: '2 3', width: 1 },
  'arrived-in': { stroke: '#38bdf8', width: 0.8 },
  'verified-by': { stroke: '#34d399', width: 1.2 },
  'leans-on': { stroke: '#f59e0b', width: 1.4 },
  replaces: { stroke: '#ef4444', dash: '6 4', width: 1.4 },
  implements: { stroke: '#a78bfa', width: 1.4 }
}

/** How far apart a link holds its ends, and how firmly: the spine is tight, atoms tighter, sideways loose. */
const LINK: Record<NetRelation, { distance: number; strength: number }> = {
  refines: { distance: 70, strength: 0.7 },
  owns: { distance: 26, strength: 0.8 },
  cites: { distance: 44, strength: 0.25 },
  concerns: { distance: 30, strength: 0.6 },
  'arrived-in': { distance: 40, strength: 0.3 },
  'verified-by': { distance: 28, strength: 0.8 },
  'leans-on': { distance: 140, strength: 0.06 },
  replaces: { distance: 140, strength: 0.06 },
  implements: { distance: 140, strength: 0.06 }
}

type XY = { x: number; y: number }
type SimNode = SimulationNodeDatum & { id: string; r: number; kind: NetNodeKind; level: number }
type SimLink = SimulationLinkDatum<SimNode> & { relation: NetRelation }

/** Ticks run before the first paint, so the map opens settled rather than as a burst. */
const WARM_TICKS = 220

/** A strict top-down tree, concepts by rung and atoms below, for the Layered view. */
function layered(network: Network): Map<string, XY> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 18, ranksep: 70, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of network.nodes) {
    const r = radiusOf(node)
    // A concept's label hangs below it; give the row room for it.
    g.setNode(node.id, { width: node.kind === 'concept' ? 150 : r * 2 + 8, height: r * 2 + (node.kind === 'concept' ? 28 : 8) })
  }
  for (const edge of network.edges) if (edge.relation !== 'leans-on' && edge.relation !== 'replaces' && edge.relation !== 'implements') g.setEdge(edge.source, edge.target)
  dagre.layout(g)
  const out = new Map<string, XY>()
  for (const node of network.nodes) {
    const p = g.node(node.id)
    const r = radiusOf(node)
    if (p) out.set(node.id, { x: p.x - r, y: p.y - r })
  }
  return out
}

interface DotData extends Record<string, unknown> {
  node: NetNode
  dimmed: boolean
  picked: boolean
}

const CENTER = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' } as const

function Dot({ data }: NodeProps<Node<DotData>>): React.JSX.Element {
  const { node, dimmed, picked } = data
  const r = radiusOf(node)
  const fill = node.kind === 'concept' ? EFFECT_FILL[node.concept!.effect] : ATOM_FILL[node.kind]
  const showLabel = node.kind === 'concept' || node.kind === 'commit' || node.kind === 'test'
  return (
    <div className={cn('relative transition-opacity duration-150', dimmed && 'opacity-15')} title={node.kind === 'concept' ? node.concept!.summary : (node.path ?? node.sha ?? node.label)}>
      <Handle type="target" position={Position.Top} style={CENTER} className="opacity-0!" />
      <Handle type="source" position={Position.Top} style={CENTER} className="opacity-0!" />
      <div
        className={cn(
          'rounded-full border-2 border-background shadow-sm',
          node.kind === 'concept' && node.concept!.effect === 'context' && 'border-dashed! border-muted-foreground!',
          node.kind === 'concept' && !node.verified && node.level > 0 && 'ring-1 ring-amber-400/60',
          picked && 'ring-2 ring-primary ring-offset-1 ring-offset-background'
        )}
        style={{ width: r * 2, height: r * 2, background: fill }}
      />
      {showLabel ? (
        <span
          className={cn(
            'pointer-events-none absolute left-1/2 top-full mt-0.5 w-max -translate-x-1/2 truncate text-center text-muted-foreground',
            node.kind === 'concept' ? (node.level === 0 ? 'max-w-56 text-[11px] font-medium text-foreground' : 'max-w-40 text-[10px]') : 'max-w-28 font-mono text-[9px]'
          )}
        >
          {node.label}
        </span>
      ) : null}
    </div>
  )
}

const nodeTypes = { dot: Dot }

/** The whole map as a living network. */
export function ConceptNetwork({
  network,
  layout,
  picked,
  onPick
}: {
  network: Network
  layout: NetworkLayout
  /** The dot the inspector is open on. */
  picked?: string
  onPick: (node: NetNode) => void
}): React.JSX.Element {
  const { theme } = useTheme()
  const byId = useMemo(() => new Map(network.nodes.map((node) => [node.id, node])), [network])
  const [hovered, setHovered] = useState<string | undefined>(undefined)
  const focus = hovered ?? picked
  const lit = useMemo(() => (focus ? neighbourhood(network, focus) : undefined), [network, focus])

  // The simulation owns the positions in the radial view; React is told about them a frame at a
  // time, every other frame, which is plenty for the eye and leaves the edge layer time to draw.
  const sim = useRef<Simulation<SimNode, SimLink> | null>(null)
  const simNodes = useRef<SimNode[]>([])
  const [positions, setPositions] = useState<Map<string, XY>>(() => new Map())
  const frame = useRef<number | null>(null)
  const skip = useRef(false)

  useEffect(() => {
    if (layout === 'layered') {
      sim.current?.stop()
      sim.current = null
      setPositions(layered(network))
      return
    }
    const nodes: SimNode[] = network.nodes.map((node) => {
      const r = radiusOf(node)
      const angle = Math.random() * Math.PI * 2
      const ring = node.level * RING
      return { id: node.id, r, kind: node.kind, level: node.level, x: Math.cos(angle) * ring, y: Math.sin(angle) * ring }
    })
    const links: SimLink[] = network.edges.map((edge) => ({ source: edge.source, target: edge.target, relation: edge.relation }))
    const simulation = forceSimulation<SimNode, SimLink>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => LINK[l.relation].distance)
          .strength((l) => LINK[l.relation].strength)
      )
      .force('charge', forceManyBody<SimNode>().strength((d) => (d.kind === 'concept' ? -140 - 60 * Math.max(0, 3 - d.level) : -24)))
      .force('collide', forceCollide<SimNode>((d) => d.r + (d.kind === 'concept' ? 16 : 4)).strength(0.9))
      // Each rung on its own ring: that is the hierarchy, drawn. The root is pinned to the centre.
      .force('ring', forceRadial<SimNode>((d) => d.level * RING, 0, 0).strength((d) => (d.kind === 'concept' ? 0.55 : 0.25)))
      .force('x', forceX<SimNode>(0).strength(0.015))
      .force('y', forceY<SimNode>(0).strength(0.015))
      .alphaDecay(0.025)
      .velocityDecay(0.4)
      .stop()
    const root = nodes.find((n) => n.level === 0)
    if (root) {
      root.fx = 0
      root.fy = 0
    }

    const snapshot = (): Map<string, XY> => new Map(nodes.map((n) => [n.id, { x: (n.x ?? 0) - n.r, y: (n.y ?? 0) - n.r }]))
    // Settle first, then paint, then carry on live from wherever that left the heat.
    for (let i = 0; i < WARM_TICKS; i++) simulation.tick()
    setPositions(snapshot())

    const publish = (): void => {
      frame.current = null
      setPositions(snapshot())
    }
    simulation.on('tick', () => {
      skip.current = !skip.current
      if (skip.current || frame.current !== null) return
      frame.current = requestAnimationFrame(publish)
    })
    simulation.restart()
    sim.current = simulation
    simNodes.current = nodes
    return () => {
      simulation.stop()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      sim.current = null
    }
  }, [network, layout])

  const simNode = (id: string): SimNode | undefined => simNodes.current.find((n) => n.id === id)
  const pin = (id: string, at: XY): void => {
    const n = simNode(id)
    if (!n) return
    n.fx = at.x + n.r
    n.fy = at.y + n.r
  }

  const nodes: Node<DotData>[] = useMemo(
    () =>
      network.nodes.map((node) => {
        const r = radiusOf(node)
        return {
          id: node.id,
          type: 'dot',
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          width: r * 2,
          height: r * 2,
          draggable: layout === 'radial',
          data: { node, dimmed: lit !== undefined && !lit.has(node.id), picked: node.id === picked }
        }
      }),
    [network, positions, lit, picked, layout]
  )

  const edges: Edge[] = useMemo(
    () =>
      network.edges.map((edge: NetEdge) => {
        const style = EDGE_STYLE[edge.relation]
        const touches = lit === undefined || (lit.has(edge.source) && lit.has(edge.target))
        const showLabel = edge.label !== undefined && lit !== undefined && touches
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: layout === 'radial' ? 'straight' : 'default',
          label: showLabel ? edge.label : undefined,
          labelStyle: { fontSize: 9, fill: style.stroke },
          labelBgStyle: { fill: 'var(--card)' },
          style: { stroke: style.stroke, strokeWidth: style.width, strokeDasharray: style.dash, opacity: touches ? 0.9 : 0.06 }
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
    const n = simNode(node.id)
    // The root stays where it is; anything else is let go to find its place again.
    if (n && n.level > 0) {
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
        const node = byId.get(n.id)
        if (node) onPick(node)
      }}
      proOptions={{ hideAttribution: true }}
      className="bg-background"
    >
      <Background gap={18} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => ((n.data as DotData).node.kind === 'concept' ? 'var(--foreground)' : 'var(--muted-foreground)')} />
    </ReactFlow>
  )
}

export function NetworkLegend({ affected }: { affected: number }): React.JSX.Element {
  const dot = (fill: string, extra?: string) => <span className={cn('inline-block size-2.5 rounded-full', extra)} style={{ background: fill }} />
  return (
    <div className="pointer-events-none absolute top-2 left-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur">
      <span className="flex items-center gap-1">{dot(EFFECT_FILL.added)} added</span>
      <span className="flex items-center gap-1">{dot(EFFECT_FILL.reshaped)} reshaped</span>
      <span className="flex items-center gap-1">{dot(EFFECT_FILL.removed)} removed</span>
      <span className="flex items-center gap-1">{dot('transparent', 'border border-dashed border-muted-foreground')} context</span>
      <span className="text-border">|</span>
      <span className="flex items-center gap-1">{dot(ATOM_FILL.hunk)} hunk</span>
      <span className="flex items-center gap-1">{dot(ATOM_FILL.test)} test</span>
      <span className="flex items-center gap-1">{dot(ATOM_FILL.commit)} commit</span>
      <span className="flex items-center gap-1">{dot(ATOM_FILL.path)} file</span>
      <span className="text-border">|</span>
      <span className="flex items-center gap-1">
        <span className="inline-block size-2.5 rounded-full ring-1 ring-amber-400/70" /> no test under it
      </span>
      {affected > 0 ? <span className="text-amber-500">{affected} worth a look</span> : null}
    </div>
  )
}
