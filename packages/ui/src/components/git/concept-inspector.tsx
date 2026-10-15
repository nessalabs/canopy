import { useMemo, useState } from 'react'
import { GitCommitHorizontal, X } from 'lucide-react'

import { coverageOf, type ChangedFile, type ConceptEffect, type DiffSpec, type ReviewComment } from '@canopy/shared'

import { LinkedMarkdown } from '@/components/agent/answer-links'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { DiffMode } from '@/components/worktree-diff'
import { useDiffFiles, useFilePatches } from '@/lib/api-hooks'
import { conceptFiles, reviewedKey } from '@/lib/concept-graph'
import type { NetEdge, NetNode, NetRelation, Network } from '@/lib/concept-network'
import { slicePatch } from '@/lib/patch'
import { cn } from '@/lib/utils'

import { ContentPane } from './content-pane'

/**
 * What one dot on the network is, beside the network: the concept or atom, what the change did to
 * it, every link in and out as a chip that walks the panel to the other end, the commits it arrived
 * in, and the diff itself. The graph stays alive on the left the whole time.
 */

const EFFECT_WORD: Record<ConceptEffect, string> = {
  added: 'Added by this change',
  reshaped: 'Reshaped by this change',
  replaced: 'Replaces something older',
  removed: 'Removed by this change',
  context: 'Already existed — only leaned on'
}

const KIND_WORD: Record<NetNode['kind'], string> = { concept: 'concept', hunk: 'hunk', test: 'test', commit: 'commit', path: 'file' }

/** How a link reads from this node's side, outgoing and incoming. */
const OUT: Record<NetRelation, string> = {
  refines: 'Finer accounts of it',
  owns: 'Its code',
  cites: 'Cites',
  concerns: 'Lives in',
  'arrived-in': 'Arrived in',
  'verified-by': 'Verified by',
  'leans-on': 'Leans on',
  replaces: 'Replaces',
  implements: 'Implements'
}
const IN: Record<NetRelation, string> = {
  refines: 'A finer account of',
  owns: 'Home of this code',
  cites: 'Cited by',
  concerns: 'Concerns',
  'arrived-in': 'Brought in',
  'verified-by': 'Verifies',
  'leans-on': 'Leaned on by',
  replaces: 'Replaced by',
  implements: 'Implemented by'
}

/** The order the groups read in: the spine first, then what it rests on, then the sideways links. */
const ORDER: NetRelation[] = ['refines', 'owns', 'verified-by', 'cites', 'concerns', 'arrived-in', 'leans-on', 'replaces', 'implements']

/** A file's stub for the content pane when the diff list no longer has it (the map is older than the diff). */
const stub = (path: string): ChangedFile => ({ path, status: 'M', additions: 0, deletions: 0, binary: false, staged: 'unstaged', conflicted: false, headSha: null }) as ChangedFile

function Chip({ node, onPick }: { node: NetNode; onPick: (id: string) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onPick(node.id)}
      title={node.kind === 'concept' ? node.concept!.summary : (node.path ?? node.sha ?? node.label)}
      className={cn('max-w-full truncate rounded border border-border px-1.5 py-0.5 text-left text-[11px] hover:bg-accent', node.kind !== 'concept' && 'font-mono text-muted-foreground')}
    >
      {node.label}
    </button>
  )
}

/** Every link touching the node, grouped by how it reads from here. */
function Links({ network, id, onPick }: { network: Network; id: string; onPick: (id: string) => void }): React.JSX.Element | null {
  const byId = useMemo(() => new Map(network.nodes.map((node) => [node.id, node])), [network])
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; nodes: NetNode[] }>()
    const add = (key: string, label: string, other: NetNode | undefined): void => {
      if (!other) return
      const group = out.get(key) ?? { label, nodes: [] }
      if (!group.nodes.some((n) => n.id === other.id)) group.nodes.push(other)
      out.set(key, group)
    }
    for (const edge of network.edges as NetEdge[]) {
      if (edge.source === id) add(`out:${edge.relation}`, OUT[edge.relation], byId.get(edge.target))
      else if (edge.target === id) add(`in:${edge.relation}`, IN[edge.relation], byId.get(edge.source))
    }
    return [...out.entries()].sort(([a], [b]) => {
      const [da, ra] = a.split(':') as [string, NetRelation]
      const [db, rb] = b.split(':') as [string, NetRelation]
      return ORDER.indexOf(ra) - ORDER.indexOf(rb) || da.localeCompare(db)
    })
  }, [network, id, byId])
  if (groups.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {groups.map(([key, { label, nodes }]) => (
        <div key={key} className="flex flex-col gap-1">
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
          <div className="flex flex-wrap gap-1">
            {nodes.map((node) => (
              <Chip key={node.id} node={node} onPick={onPick} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ConceptInspector({
  network,
  nodeId,
  worktreeId,
  spec,
  comments,
  mode,
  reviewed,
  onReviewed,
  onPick,
  onClose
}: {
  network: Network
  nodeId: string
  worktreeId: string
  spec: DiffSpec
  comments: ReviewComment[]
  mode: DiffMode
  reviewed: ReadonlySet<string>
  onReviewed: (key: string, on: boolean) => void
  onPick: (id: string) => void
  onClose: () => void
}): React.JSX.Element | null {
  const node = useMemo(() => network.nodes.find((candidate) => candidate.id === nodeId), [network, nodeId])
  // Metadata from the same two trees the patch is read between. Taken from the worktree's diff, a
  // file the PR adds showed as modified with no counts, and a committed file could not be opened.
  const files = useDiffFiles(worktreeId, spec).data?.files ?? []
  const concept = node?.kind === 'concept' ? node.concept : undefined

  // What there is to read: a concept's whole coverage, an atom's one block, a changed file whole.
  const own = useMemo(() => {
    if (concept) return conceptFiles(coverageOf(concept))
    if (node?.path && (node.kind === 'hunk' || node.kind === 'test')) return [{ path: node.path, ...(node.hunk !== undefined ? { hunks: [node.hunk] } : {}) }]
    if (node?.path && files.some((file) => file.path === node.path)) return [{ path: node.path }]
    return []
  }, [concept, node, files])
  const patches = useFilePatches(worktreeId, spec, own.map((file) => file.path))
  const [picked, setPicked] = useState(0)
  const shown = own[Math.min(picked, own.length - 1)]
  const changed = shown ? (files.find((file) => file.path === shown.path) ?? stub(shown.path)) : undefined
  const key = concept ? reviewedKey(coverageOf(concept)) : undefined

  if (!node) return null
  return (
    <aside className="flex h-full min-h-0 w-[30rem] shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {KIND_WORD[node.kind]}
            {concept?.kind ? ` · ${concept.kind}` : ''}
            {concept && node.level > 0 ? ` · rung ${node.level}` : ''}
          </p>
          <h3 className={cn('leading-snug font-semibold', concept ? 'text-base' : 'font-mono text-sm')}>{concept ? concept.title : (node.path ?? node.sha ?? node.label)}</h3>
          {concept ? <p className="text-xs text-muted-foreground">{EFFECT_WORD[concept.effect]}</p> : null}
        </div>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Close" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {concept?.summary ? <LinkedMarkdown className="text-sm text-muted-foreground">{concept.summary}</LinkedMarkdown> : null}
        {concept && concept.layers.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {concept.layers.map((layer) => (
              <Badge key={layer} variant="outline" className="font-normal text-muted-foreground">
                {layer}
              </Badge>
            ))}
          </div>
        ) : null}
        {concept && !node.verified && node.level > 0 ? <p className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">Nothing under this concept looks like a test.</p> : null}

        <Links network={network} id={node.id} onPick={onPick} />

        {concept && concept.commits.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <GitCommitHorizontal className="size-3.5 text-muted-foreground" />
            {concept.commits.map((sha) => (
              <button key={sha} type="button" onClick={() => onPick(`commit:${sha}`)} className="rounded px-1 font-mono text-[11px] text-muted-foreground hover:bg-accent">
                {sha.slice(0, 7)}
              </button>
            ))}
          </div>
        ) : null}

        {own.length > 1 ? (
          <ul className="flex flex-col gap-0.5" aria-label="Files under this concept">
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

        {key ? (
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={reviewed.has(key)} onChange={() => onReviewed(key, !reviewed.has(key))} className="size-3.5" />
            Reviewed
          </label>
        ) : null}
      </div>

      <div className="min-h-0 flex-[2] border-t border-border">
        {changed && shown ? (
          <ContentPane key={`${node.id}:${shown.path}`} worktreeId={worktreeId} spec={spec} file={changed} hunks={shown.hunks} comments={comments.filter((comment) => comment.file === shown.path)} mode={mode} />
        ) : (
          <p className="px-4 py-4 text-xs text-muted-foreground">
            {node.kind === 'commit' ? 'A commit the concepts above arrived in.' : node.kind === 'path' ? 'This file is not part of the diff — the change leans on it without touching it.' : 'No changed code of its own.'}
          </p>
        )}
      </div>
    </aside>
  )
}
