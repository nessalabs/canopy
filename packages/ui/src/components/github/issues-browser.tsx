import { useEffect, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'

import type { IssueSummary } from '@canopy/shared'

import { AttachmentPreview } from '@/components/agent/attachment-preview'
import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { ChatTabs } from '@/components/ui/chat-tabs'
import { Input } from '@/components/ui/input'
import { useIssueAssignees, useIssueSearch } from '@/lib/api-hooks'
import { relativeTime } from '@/lib/format'
import { EMPTY_READER, readerSteps, type Reading, type ReaderTabs } from '@/lib/reader-tabs'
import { tabPanelProps } from '@/lib/tab-panel'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'

import { attachmentName, GitHubAttachmentView } from './attachment-view'
import { IssueFilterBar, OPEN_ISSUES } from './issue-filter'
import { IssueStateBadge, IssueView, opensNewTab } from './issue-view'

/** How many the list shows to begin with, and how many more each Show more adds. */
const PAGE = 10

const titleOf = (reading: Reading): string => (reading.kind === 'issue' ? `#${reading.number}` : reading.kind === 'github' ? attachmentName(reading.url) : reading.kind === 'plan' ? 'Plan' : reading.attachment.label)

/** A reader's tabs and the steps that move them, for a pane that reads issues and attachments. */
export function useReader() {
  const [state, setState] = useState<ReaderTabs>(EMPTY_READER)
  const step =
    <Args extends unknown[]>(fn: (state: ReaderTabs, ...args: Args) => ReaderTabs) =>
    (...args: Args): void =>
      setState((current) => fn(current, ...args))
  const tab = state.tabs.find((t) => t.id === state.active)
  return {
    state,
    current: tab?.trail.at(-1),
    previous: tab?.trail.at(-2),
    show: step(readerSteps.show),
    open: step(readerSteps.open),
    follow: step(readerSteps.follow),
    back: step(readerSteps.back),
    select: step(readerSteps.select),
    close: step(readerSteps.close)
  }
}

export type Reader = ReturnType<typeof useReader>

function IssueListRow({ item, active, onPick }: { item: IssueSummary; active: boolean; onPick: (newTab: boolean) => void }): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={(event) => onPick(opensNewTab(event))}
        title="Shift-click to open in a new tab"
        aria-current={active || undefined}
        className={cn('flex w-full flex-col gap-1 border-b border-border px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent', active && 'bg-accent')}
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 text-sm leading-snug font-medium">{item.title}</span>
          <IssueStateBadge state={item.state} kind={item.kind} className="px-1.5 py-0 text-[10px]" />
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {item.kind === 'pr' ? 'PR' : 'Issue'} #{item.number} · {item.author ?? 'ghost'} · {relativeTime(Date.parse(item.updatedAt))}
          {item.assignees.length > 0 ? ` · → ${item.assignees.join(', ')}` : ''}
        </span>
      </button>
    </li>
  )
}

/** The repository's issues and PRs, searched on GitHub as the query settles. */
function IssueList({ projectId, active, onPick }: { projectId: string; active: number | undefined; onPick: (number: number, newTab: boolean) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState(OPEN_ISSUES)
  const [limit, setLimit] = useState(PAGE)
  const settled = useDebounced(query.trim(), 250)
  // A new search starts from the first page again.
  useEffect(() => setLimit(PAGE), [settled, filter])
  const search = useIssueSearch(projectId, settled, filter, limit)
  const assignees = useIssueAssignees(projectId)
  const items = search.data?.items ?? []
  const gh = search.data?.gh
  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search issues and PRs, or #number"
          aria-label="Search issues and pull requests"
          className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
        />
      </label>
      <IssueFilterBar filter={filter} onChange={setFilter} assignees={assignees.data} />
      {search.error ? <ErrorNote error={search.error} /> : null}
      {gh && gh.state !== 'ready' ? <p className="p-3 text-xs text-muted-foreground">GitHub is not set up for this repository ({gh.state}). The Pull request view shows how to connect it.</p> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-busy={search.isFetching || undefined}>
        {items.map((item) => (
          <IssueListRow key={item.number} item={item} active={item.number === active} onPick={(newTab) => onPick(item.number, newTab)} />
        ))}
        {search.data && items.length === 0 && gh?.state === 'ready' ? <li className="p-3 text-xs text-muted-foreground">Nothing matches.</li> : null}
        {items.length === limit ? (
          <li className="p-2">
            <Button size="sm" variant="ghost" className="h-7 w-full text-xs" disabled={search.isFetching} onClick={() => setLimit((current) => current + PAGE)}>
              Show more
            </Button>
          </li>
        ) : null}
        {search.isPending ? <li className="p-3 text-xs text-muted-foreground">Searching GitHub…</li> : null}
      </ul>
    </div>
  )
}

/**
 * One reading, with the links inside an issue followed into the same reader — or a new tab of it.
 * The plan belongs to whoever hosts the reader, so it comes in drawn as `plan`.
 */
export function ReadingView({ projectId, reading, onFollow, plan }: { projectId: string; reading: Reading; onFollow: (next: Reading, newTab: boolean) => void; plan?: React.ReactNode }): React.JSX.Element {
  if (reading.kind === 'plan') return <>{plan}</>
  if (reading.kind === 'issue') {
    return (
      <IssueView
        projectId={projectId}
        number={reading.number}
        onOpenIssue={(number, newTab) => onFollow({ kind: 'issue', number }, newTab)}
        onOpenAttachment={(url, newTab) => onFollow({ kind: 'github', url }, newTab)}
      />
    )
  }
  if (reading.kind === 'github') return <GitHubAttachmentView projectId={projectId} url={reading.url} />
  return <AttachmentPreview attachment={reading.attachment} />
}

/** A reader: its tabs once there is more than one, Back along the tab's trail, and what it shows. */
export function ReaderPane({ projectId, reader, empty, plan }: { projectId: string; reader: Reader; empty: React.ReactNode; plan?: React.ReactNode }): React.JSX.Element {
  const { state, current, previous } = reader
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      {state.tabs.length > 1 ? (
        <ChatTabs
          tabs={state.tabs.map((t) => ({ id: t.id, title: titleOf(t.trail.at(-1)!), closeable: true }))}
          value={state.active ?? null}
          onValueChange={reader.select}
          onClose={reader.close}
          label="Open issues and files"
          className="shrink-0 border-b border-border px-2 py-1 [&_[data-slot=chat-tab]]:rounded-[4px]"
        />
      ) : null}
      {previous ? (
        <div className="shrink-0 border-b border-border px-2 py-1">
          <Button size="sm" variant="ghost" className="h-7 rounded-[4px] text-xs" onClick={reader.back}>
            <ArrowLeft aria-hidden="true" /> Back to {titleOf(previous)}
          </Button>
        </div>
      ) : null}
      <div {...(state.tabs.length > 1 && state.active && current ? tabPanelProps(state.active, titleOf(current)) : {})} className="min-h-0 flex-1 overflow-y-auto">
        {current ? <ReadingView key={state.active} projectId={projectId} reading={current} onFollow={reader.follow} plan={plan} /> : empty}
      </div>
    </section>
  )
}

/**
 * The Git tab's Issues view: the repository's issues and PRs on the left, the one picked on the
 * right, read as GitHub shows it. A pick replaces what the reader shows, a shift-click opens a
 * tab of its own, and links inside an issue open in place with Back.
 */
export function IssuesBrowser({ projectId, reader }: { projectId: string; reader: Reader }): React.JSX.Element {
  const { current } = reader
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-80 shrink-0 border-r border-border">
        <IssueList
          projectId={projectId}
          active={current?.kind === 'issue' ? current.number : undefined}
          onPick={(number, newTab) => (newTab ? reader.follow({ kind: 'issue', number }, true) : reader.open({ kind: 'issue', number }))}
        />
      </aside>
      <ReaderPane
        projectId={projectId}
        reader={reader}
        empty={<p className="p-6 text-xs text-muted-foreground">Pick an issue or pull request to read it here; shift-click to open it in a new tab. In any composer, type # to hand one to the agent.</p>}
      />
    </div>
  )
}
