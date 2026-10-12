import { useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'

import type { IssueSummary } from '@canopy/shared'

import { AttachmentPreview, type PreviewedAttachment } from '@/components/agent/attachment-preview'
import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIssueSearch } from '@/lib/api-hooks'
import { relativeTime } from '@/lib/format'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'

import { attachmentName, GitHubAttachmentView } from './attachment-view'
import { IssueFilterBar, OPEN_ISSUES } from './issue-filter'
import { IssueStateBadge, IssueView } from './issue-view'

/** What the reader shows: an issue or PR, a file attached on GitHub, or text staged in a composer. */
export type Reading = { kind: 'issue'; number: number } | { kind: 'github'; url: string } | { kind: 'staged'; attachment: PreviewedAttachment }

const sameReading = (a: Reading | undefined, b: Reading): boolean => JSON.stringify(a) === JSON.stringify(b)

const titleOf = (reading: Reading): string =>
  reading.kind === 'issue' ? `#${reading.number}` : reading.kind === 'github' ? attachmentName(reading.url) : reading.attachment.label

/**
 * What is open in the reader and how it got there: following a link pushes, Back pops, and
 * picking from the list starts over. `open` is how anything outside — a chip in the Git Agent —
 * puts something in front of the reader.
 */
export function useReader(): { current: Reading | undefined; previous: Reading | undefined; open: (next: Reading) => void; follow: (next: Reading) => void; back: () => void } {
  const [trail, setTrail] = useState<Reading[]>([])
  return {
    current: trail.at(-1),
    previous: trail.at(-2),
    open: (next) => setTrail([next]),
    follow: (next) => setTrail((current) => (sameReading(current.at(-1), next) ? current : [...current, next])),
    back: () => setTrail((current) => current.slice(0, -1))
  }
}

function IssueListRow({ item, active, onPick }: { item: IssueSummary; active: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-current={active || undefined}
        className={cn('flex w-full flex-col gap-1 border-b border-border px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent', active && 'bg-accent')}
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 text-sm leading-snug font-medium">{item.title}</span>
          <IssueStateBadge state={item.state} kind={item.kind} className="px-1.5 py-0 text-[10px]" />
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {item.kind === 'pr' ? 'PR' : 'Issue'} #{item.number} · {item.author ?? 'ghost'} · {relativeTime(Date.parse(item.updatedAt))}
        </span>
      </button>
    </li>
  )
}

/** The repository's issues and PRs, searched on GitHub as the query settles. */
function IssueList({ projectId, active, onPick }: { projectId: string; active: number | undefined; onPick: (number: number) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState(OPEN_ISSUES)
  const search = useIssueSearch(projectId, useDebounced(query.trim(), 250), filter)
  const gh = search.data?.gh
  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search issues and PRs, or #number" aria-label="Search issues and pull requests" className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0" />
      </label>
      <IssueFilterBar filter={filter} onChange={setFilter} />
      {search.error ? <ErrorNote error={search.error} /> : null}
      {gh && gh.state !== 'ready' ? <p className="p-3 text-xs text-muted-foreground">GitHub is not set up for this repository ({gh.state}). The Pull request view shows how to connect it.</p> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-busy={search.isFetching || undefined}>
        {(search.data?.items ?? []).map((item) => (
          <IssueListRow key={item.number} item={item} active={item.number === active} onPick={() => onPick(item.number)} />
        ))}
        {search.data && search.data.items.length === 0 && gh?.state === 'ready' ? <li className="p-3 text-xs text-muted-foreground">Nothing matches.</li> : null}
        {search.isPending ? <li className="p-3 text-xs text-muted-foreground">Searching GitHub…</li> : null}
      </ul>
    </div>
  )
}

/** One reading, with the links inside an issue followed into the same reader. */
export function ReadingView({ projectId, reading, onFollow }: { projectId: string; reading: Reading; onFollow: (next: Reading) => void }): React.JSX.Element {
  if (reading.kind === 'issue') {
    return <IssueView projectId={projectId} number={reading.number} onOpenIssue={(number) => onFollow({ kind: 'issue', number })} onOpenAttachment={(url) => onFollow({ kind: 'github', url })} />
  }
  if (reading.kind === 'github') return <GitHubAttachmentView projectId={projectId} url={reading.url} />
  return <AttachmentPreview attachment={reading.attachment} />
}

/**
 * The Git tab's Issues view: the repository's issues and PRs on the left, the one picked on the
 * right, read as GitHub shows it. Issue links and attachments inside it open in place, with Back.
 */
export function IssuesBrowser({ projectId, reader }: { projectId: string; reader: ReturnType<typeof useReader> }): React.JSX.Element {
  const { current, previous } = reader
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-80 shrink-0 border-r border-border">
        <IssueList projectId={projectId} active={current?.kind === 'issue' ? current.number : undefined} onPick={(number) => reader.open({ kind: 'issue', number })} />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {previous ? (
          <div className="shrink-0 border-b border-border px-2 py-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={reader.back}>
              <ArrowLeft aria-hidden="true" /> {titleOf(previous)}
            </Button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {current ? (
            <ReadingView projectId={projectId} reading={current} onFollow={reader.follow} />
          ) : (
            <p className="p-6 text-xs text-muted-foreground">Pick an issue or pull request to read it here. In any composer, type # to hand one to the agent.</p>
          )}
        </div>
      </section>
    </div>
  )
}
