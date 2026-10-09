import { createContext, useContext, useMemo, useState } from 'react'
import type { Components } from 'react-markdown'

import { BeforeAfterSpec, BlastRadiusSpec, CallFlowSpec, DataModelSpec, parseGroupJson } from '@canopy/shared'

import { BeforeAfter } from '@/components/ui/before-after'
import { BlastRadius } from '@/components/ui/blast-radius'
import { CallFlow } from '@/components/ui/call-flow'
import { ChangeMap, type ChangeMapNode } from '@/components/ui/change-map'
import { DataModel } from '@/components/ui/data-model'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { parseChangeMap, parseDrawing, partLabel, partRef, remarkDrawnBlocks, type DrawingSchema, type Located } from '@/lib/change-map'
import { remarkFileRefs } from '@/lib/file-refs'

/**
 * Where a conversation sends a clicked link that names a file: the host answers whether it
 * opened it. Absent — the Agent tab today — answers link nothing, so no reference becomes a
 * link that leads nowhere.
 */
export type OpenFileRef = (href: string) => boolean

const FileRefContext = createContext<OpenFileRef | null>(null)

/**
 * A ```change-map block, drawn: the parts of the change as cards, each opening its code when
 * the host can. Until the block parses — it is still streaming in — a placeholder holds its place.
 */
function ChangeMapBlock({ source = '' }: { source?: string }): React.JSX.Element {
  const open = useContext(FileRefContext)
  const spec = useMemo(() => parseChangeMap(source), [source])
  const [selected, setSelected] = useState<string>()
  if (!spec) return <Pending label="Drawing the change map…" />
  const nodes = spec.nodes.map((part): ChangeMapNode => ({ id: part.id, label: part.label, detail: partLabel(part), status: part.status, badge: part.badge }))
  const select = (node: ChangeMapNode): void => {
    setSelected(node.id)
    const ref = partRef(spec.nodes.find((part) => part.id === node.id)!)
    if (ref) open?.(ref)
  }
  return (
    <ChangeMap
      title={spec.title}
      nodes={nodes}
      edges={spec.edges}
      caption={spec.caption ?? (open ? 'Click a block to open its diff.' : undefined)}
      selectedId={selected}
      onSelect={open ? select : undefined}
      className="my-3"
    />
  )
}

/**
 * A ```change-groups block — a grouping the Groups pane draws — as the list of features it names,
 * so the chat reads as prose rather than JSON. The cards themselves live in the Groups tab.
 */
function ChangeGroupsBlock({ source = '' }: { source?: string }): React.JSX.Element {
  const reply = useMemo(() => parseGroupJson(source), [source])
  if (!reply) return <div className="my-2 animate-pulse rounded-xl border border-border bg-muted/40 px-4 py-4 text-center text-xs text-muted-foreground">Grouping the change…</div>
  return (
    <section className="my-3 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground">
      <p className="text-xs font-medium text-muted-foreground">
        {reply.groups.length} {reply.groups.length === 1 ? 'group' : 'groups'} · open the Groups tab to review them
      </p>
      <ol className="mt-2 flex flex-col gap-1 text-sm">
        {reply.groups.map((group, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{i + 1}</span>
            <span className="min-w-0">
              {group.title}
              {group.parts.length > 0 ? <span className="text-muted-foreground"> · {group.parts.length} parts</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** While a drawn block is still streaming in, its place is held. */
const Pending = ({ label }: { label: string }): React.JSX.Element => (
  <div className="my-2 animate-pulse rounded-2xl border border-border bg-muted/40 px-4 py-6 text-center text-xs text-muted-foreground">{label}</div>
)

/** Opens a part's code, when the host can and the part names it. */
type OpenPart = (part: Located | undefined) => void

/**
 * One drawn block: parsed with its schema, a placeholder until it parses, then drawn — with
 * clicks opening the code a part names wherever the host opens files.
 */
function drawnBlock<T extends { caption?: string }>(schema: DrawingSchema<T>, pending: string, Draw: (props: { spec: T; caption?: string; open?: OpenPart }) => React.JSX.Element) {
  return function DrawnBlock({ source = '' }: { source?: string }): React.JSX.Element {
    const opener = useContext(FileRefContext)
    const spec = useMemo(() => parseDrawing(schema, source), [source])
    if (!spec) return <Pending label={pending} />
    const open: OpenPart | undefined = opener
      ? (part) => {
          const ref = part && partRef(part)
          if (ref) opener(ref)
        }
      : undefined
    return <Draw spec={spec} caption={spec.caption ?? (open ? 'Click a part to open its code.' : undefined)} open={open} />
  }
}

const byId = <T extends { id: string }>(items: readonly T[], id: string): T | undefined => items.find((item) => item.id === id)

const CallFlowBlock = drawnBlock(CallFlowSpec, 'Drawing the call flow…', ({ spec, caption, open }) => (
  <CallFlow
    title={spec.title}
    caption={caption}
    participants={spec.participants}
    steps={spec.steps}
    onSelectParticipant={open && ((participant) => open(byId(spec.participants, participant.id)))}
    onSelectStep={open && ((_step, index) => open(spec.steps[index]))}
    className="my-3"
  />
))

const BlastRadiusBlock = drawnBlock(BlastRadiusSpec, 'Drawing the blast radius…', ({ spec, caption, open }) => {
  const all = [...spec.changed, ...spec.upstream, ...spec.downstream, ...spec.tests]
  return (
    <BlastRadius
      title={spec.title}
      caption={caption}
      changed={spec.changed}
      upstream={spec.upstream}
      downstream={spec.downstream}
      tests={spec.tests}
      links={spec.links}
      onSelect={open && ((item) => open(byId(all, item.id)))}
      className="my-3"
    />
  )
})

const BeforeAfterBlock = drawnBlock(BeforeAfterSpec, 'Drawing before and after…', ({ spec, caption, open }) => (
  <BeforeAfter
    title={spec.title}
    caption={caption}
    beforeTitle={spec.beforeTitle}
    afterTitle={spec.afterTitle}
    rows={spec.rows}
    flows={spec.flows}
    onSelect={open && ((row, side) => open(byId(spec.rows, row.id)?.[side]))}
    className="my-3"
  />
))

const DataModelBlock = drawnBlock(DataModelSpec, 'Drawing the data model…', ({ spec, caption, open }) => (
  <DataModel
    title={spec.title}
    caption={caption}
    entities={spec.entities}
    relations={spec.relations}
    onSelectEntity={open && ((entity) => open(byId(spec.entities, entity.id)))}
    className="my-3"
  />
))

const PLUGINS = [remarkFileRefs, remarkDrawnBlocks]
// Each drawn block is an element named for its language; react-markdown renders any element it is given a component for.
const COMPONENTS = {
  'change-map': ChangeMapBlock,
  'change-groups': ChangeGroupsBlock,
  'call-flow': CallFlowBlock,
  'blast-radius': BlastRadiusBlock,
  'before-after': BeforeAfterBlock,
  'data-model': DataModelBlock
} as Components

/**
 * How an answer renders where a host opens files: references become links and change maps are
 * drawn. Elsewhere it renders as plain markdown.
 */
export function useLinkedMarkdown(): { remarkPlugins?: typeof PLUGINS; components?: Components } {
  return useContext(FileRefContext) ? { remarkPlugins: PLUGINS, components: COMPONENTS } : {}
}

/** An answer's markdown: file references linked and change maps drawn wherever the host can open files. */
export function LinkedMarkdown(props: React.ComponentProps<typeof MessageMarkdown>): React.JSX.Element {
  return <MessageMarkdown {...useLinkedMarkdown()} {...props} />
}

/**
 * Hands every link clicked inside it to `onOpen` first — markdown links, the references the
 * plugin linked, and `click … href` links in a mermaid diagram alike, since all of them are
 * anchors by the time they are on screen.
 */
export function FileRefLinks({ onOpen, children }: { onOpen?: OpenFileRef; children: React.ReactNode }): React.JSX.Element {
  if (!onOpen) return <>{children}</>
  const claim = (event: React.MouseEvent): void => {
    const anchor = (event.target as Element).closest?.('a')
    const href = anchor?.getAttribute('href') ?? anchor?.getAttribute('xlink:href')
    if (!href || !onOpen(href)) return
    event.preventDefault()
    event.stopPropagation()
  }
  return (
    <FileRefContext.Provider value={onOpen}>
      <div className="contents" onClickCapture={claim}>
        {children}
      </div>
    </FileRefContext.Provider>
  )
}
