import type { PlanDrawing } from '@canopy/shared'

import { ActivityDiagram } from '@/components/ui/activity-diagram'
import { CallFlow } from '@/components/ui/call-flow'
import { ChangeMap, type StatusLabels } from '@/components/ui/change-map'
import { DataModel } from '@/components/ui/data-model'
import { StateMachine } from '@/components/ui/state-machine'

/**
 * One board drawn with Canopy's own diagrams. Every box is a button that picks it, when the host
 * picks boxes at all; each box's second line says what is going on with it (`lines`), the same on
 * every kind of drawing. The frames go untitled: the board card above names the board.
 */

export interface DrawingProps {
  drawing: PlanDrawing
  selectedId?: string
  onSelect?: (boxId: string) => void
  /** A second line per box id: its build progress, an open decision, a detail board. */
  lines?: Readonly<Record<string, string>>
  /** Only the diagram, at its natural size — for the canvas, which frames it itself. */
  bare?: boolean
  className?: string
}

/** The legend in the whiteboard's words; the colours are the drawings' own. */
export const STATUS_LABELS: StatusLabels = { added: 'New', modified: 'Changes', deleted: 'Removed', affected: 'Risk', external: 'Context' }

const withLines = <T extends { id: string }>(items: readonly T[], lines: DrawingProps['lines'] = {}): T[] => items.map((item) => (lines[item.id] ? { ...item, detail: lines[item.id] } : item))

type Draw<K extends PlanDrawing['type']> = (props: Omit<DrawingProps, 'drawing'> & { spec: Extract<PlanDrawing, { type: K }>['spec'] }) => React.JSX.Element

const DRAW: { [K in PlanDrawing['type']]: Draw<K> } = {
  'change-map': ({ spec, selectedId, onSelect, lines, bare, className }) => (
    <ChangeMap title="" statusLabels={STATUS_LABELS} nodes={withLines(spec.nodes, lines)} edges={spec.edges} selectedId={selectedId} onSelect={onSelect && ((node) => onSelect(node.id))} bare={bare} className={className} />
  ),
  activity: ({ spec, selectedId, onSelect, lines, bare, className }) => (
    <ActivityDiagram title="" statusLabels={STATUS_LABELS} steps={withLines(spec.steps, lines)} flows={spec.flows} selectedId={selectedId} onSelect={onSelect && ((step) => onSelect(step.id))} bare={bare} className={className} />
  ),
  'state-machine': ({ spec, selectedId, onSelect, lines, bare, className }) => (
    <StateMachine title="" statusLabels={STATUS_LABELS} states={withLines(spec.states, lines)} transitions={spec.transitions} selectedId={selectedId} onSelect={onSelect && ((state) => onSelect(state.id))} bare={bare} className={className} />
  ),
  'call-flow': ({ spec, selectedId, onSelect, lines, bare, className }) => (
    <CallFlow title="" statusLabels={STATUS_LABELS} participants={withLines(spec.participants, lines)} steps={spec.steps} selectedId={selectedId} onSelectParticipant={onSelect && ((participant) => onSelect(participant.id))} bare={bare} className={className} />
  ),
  'data-model': ({ spec, selectedId, onSelect, lines, bare, className }) => (
    <DataModel title="" statusLabels={STATUS_LABELS} entities={withLines(spec.entities, lines)} relations={spec.relations} selectedId={selectedId} onSelectEntity={onSelect && ((entity) => onSelect(entity.id))} bare={bare} className={className} />
  )
}

export function BoardDrawing({ drawing, ...props }: DrawingProps): React.JSX.Element {
  const Drawn = DRAW[drawing.type] as Draw<typeof drawing.type>
  return <Drawn spec={drawing.spec as never} {...props} />
}
