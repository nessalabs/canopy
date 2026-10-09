import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react'

import type { AgentProvider, Against, ChangedFile, DiffSpec, ReviewComment } from '@canopy/shared'

import { FileRefLinks, LinkedMarkdown, type OpenFileRef } from '@/components/agent/answer-links'
import { ErrorNote } from '@/components/error-note'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChangeMap, type ChangeMapNode } from '@/components/ui/change-map'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import type { DiffMode } from '@/components/worktree-diff'
import { useFilePatches } from '@/lib/api-hooks'
import { featureCards, isStale, reviewedKey, reviewSections, sectionFiles, type FeatureCard, type ReviewSection } from '@/lib/change-groups'
import { slicePatch } from '@/lib/patch'
import type { useChangeGroups } from '@/lib/use-change-groups'
import { useHotkeys } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'

import { ContentPane } from './content-pane'

type Groups = ReturnType<typeof useChangeGroups>
type View = 'overview' | 'review'

const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex' } as const

/**
 * The bar over everything: how to group, which agent groups it, the button that starts the
 * grouping conversation and the way to it, and how far the review has got.
 */
function GroupBar({ groups, done, total, stale }: { groups: Groups; done: number; total: number; stale: boolean }): React.JSX.Element {
  const [wording, setWording] = useState(groups.instructions)
  const [provider, setProvider] = useState<AgentProvider | undefined>(undefined)
  const chosen = provider ?? groups.providers[0]
  const has = groups.result !== undefined
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (chosen) void groups.group(wording, chosen)
      }}
    >
      <Input
        value={wording}
        onChange={(event) => setWording(event.target.value)}
        placeholder="How should these be grouped? For example: by layer, or tests with what they test"
        aria-label="How to group the changes"
        className="h-8 min-w-48 flex-1 text-xs"
      />
      {groups.providers.length > 1 ? (
        <SegmentedControl value={chosen} onValueChange={(value) => setProvider(value as AgentProvider)} aria-label="Agent that groups the change" className="text-xs">
          {groups.providers.map((name) => (
            <SegmentedControlOption key={name} value={name}>
              {PROVIDER_NAME[name]}
            </SegmentedControlOption>
          ))}
        </SegmentedControl>
      ) : null}
      <Button type="submit" size="sm" variant={has ? 'outline' : 'default'} disabled={groups.running || !chosen}>
        {groups.running ? 'Grouping…' : has ? 'Regroup' : 'Group changes'}
      </Button>
      {groups.openChat ? (
        <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={groups.openChat} title="The grouping conversation, in the Git Agent: ask it to merge, split or rename groups">
          <MessageSquare className="size-3.5" />
          Open chat
        </Button>
      ) : null}
      {has ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {done} of {total} reviewed
        </span>
      ) : null}
      {stale && !groups.running ? <p className="basis-full text-xs text-muted-foreground">The diff has changed since these groups were made. Regroup to include the new work.</p> : null}
    </form>
  )
}

/** Overview or one group at a time, and — while reviewing — the way from group to group. */
function Navigator({
  view,
  onView,
  sections,
  current,
  onGo,
  isReviewed
}: {
  view: View
  onView: (view: View) => void
  sections: ReviewSection[]
  current: number
  onGo: (index: number) => void
  isReviewed: (section: ReviewSection) => boolean
}): React.JSX.Element {
  const section = sections[current]
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <SegmentedControl value={view} onValueChange={(value) => onView(value as View)} aria-label="Groups view" className="text-xs">
        <SegmentedControlOption value="overview">Overview</SegmentedControlOption>
        <SegmentedControlOption value="review">One at a time</SegmentedControlOption>
      </SegmentedControl>
      {view === 'review' && section ? (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Previous group  [" title="Previous group  [" disabled={current === 0} onClick={() => onGo(current - 1)}>
            <ChevronLeft />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 min-w-0 gap-1.5 px-2 text-xs">
                <span className="text-muted-foreground tabular-nums">{section.number}</span>
                <span className="truncate">{section.title}</span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
              {sections.map((item, index) => (
                <div key={item.id}>
                  {item.heading ? <DropdownMenuLabel className="text-xs">{item.heading.title}</DropdownMenuLabel> : null}
                  <DropdownMenuItem onSelect={() => onGo(index)} className={cn('gap-2 text-xs', index === current && 'bg-accent')}>
                    <span className="w-7 shrink-0 text-muted-foreground tabular-nums">{item.number}</span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {isReviewed(item) ? <Check className="size-3.5 text-muted-foreground" aria-label="Reviewed" /> : null}
                  </DropdownMenuItem>
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Next group  ]" title="Next group  ]" disabled={current === sections.length - 1} onClick={() => onGo(current + 1)}>
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** A feature's card on the overview: what it does, how much it touches, how far it is reviewed. */
function CardBody({ card }: { card: FeatureCard }): React.JSX.Element {
  const done = card.reviewed === card.sections
  return (
    <>
      <span className="line-clamp-2 text-sm leading-snug font-semibold">{card.title}</span>
      <span className="line-clamp-3 text-xs leading-snug text-muted-foreground">{card.summary}</span>
      <span className="mt-auto flex items-center gap-2 pt-1 font-mono text-[10px] text-muted-foreground">
        <span>
          {card.files} {card.files === 1 ? 'file' : 'files'} · {card.hunks} {card.hunks === 1 ? 'hunk' : 'hunks'}
        </span>
        <span className={cn('ml-auto flex items-center gap-1', done && 'text-foreground')}>
          {done ? <Check className="size-3" /> : null}
          {card.sections > 1 || done ? `${card.reviewed}/${card.sections} reviewed` : null}
        </span>
      </span>
    </>
  )
}

/** The zoomed-out view: every feature as a card, with arrows from a feature to the ones that build on it. */
function Overview({ cards, links, current, onOpen }: { cards: FeatureCard[]; links: { from: string; to: string; label?: string }[]; current?: string; onOpen: (card: FeatureCard) => void }): React.JSX.Element {
  const nodes = useMemo<ChangeMapNode[]>(() => cards.map((card) => ({ id: card.id, label: card.title, status: card.status, badge: card.number, children: <CardBody card={card} /> })), [cards])
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  const edges = useMemo(() => links.map(({ from, to }) => ({ from, to })), [links])
  return (
    <div className="p-4">
      <ChangeMap
        title="How the change fits together"
        nodes={nodes}
        // Only the arrows: with a label on every one, a map of a dozen features reads as noise.
        edges={edges}
        arrangement="grid"
        cardSize={{ width: 260, height: 136 }}
        selectedId={current}
        onSelect={(node) => onOpen(byId.get(node.id)!)}
        caption={links.length > 0 ? 'Arrows run from a feature to the ones that build on it. Open a card to review it.' : 'Open a card to review it.'}
      />
    </div>
  )
}

/** A file's stub for the content pane when the diff list no longer has it (the groups are older than the diff). */
const stub = (path: string): ChangedFile => ({ path, status: 'M', additions: 0, deletions: 0, binary: false, staged: 'unstaged', conflicted: false, headSha: null }) as ChangedFile

/**
 * One section, on its own: the story and its files on the left, and on the right one file at a
 * time — this section's hunks of it, or the whole file — through the same pane Changes uses.
 */
function SectionView({
  worktreeId,
  spec,
  section,
  total,
  files,
  reviewed,
  onReviewed,
  onPrev,
  onNext,
  comments,
  mode
}: {
  worktreeId: string
  spec: DiffSpec
  section: ReviewSection
  /** How many features there are; a part's number counts within its feature, so it reads against them. */
  total: number
  files: ChangedFile[]
  reviewed: boolean
  onReviewed: (on: boolean) => void
  /** Absent on the first section. */
  onPrev?: () => void
  /** Absent on the last section. */
  onNext?: () => void
  comments: ReviewComment[]
  mode: DiffMode
}): React.JSX.Element {
  const own = useMemo(() => sectionFiles(section.refs), [section.refs])
  const patches = useFilePatches(worktreeId, spec, own.map((file) => file.path))
  const [picked, setPicked] = useState(0)
  const shown = own[Math.min(picked, own.length - 1)]
  const changed = shown ? (files.find((file) => file.path === shown.path) ?? stub(shown.path)) : undefined

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border px-5 py-5">
        {section.heading ? <p className="text-xs text-muted-foreground">{section.heading.title}</p> : null}
        <div className="flex items-baseline gap-2">
          <span className="text-3xl leading-none font-light text-muted-foreground tabular-nums">{section.number}</span>
          <span className="text-xs text-muted-foreground tabular-nums">of {total}</span>
          <span className="ml-auto flex self-center">
            <Button variant="ghost" size="icon" className="size-7" aria-label="Previous group  [" title="Previous group  [" disabled={!onPrev} onClick={onPrev}>
              <ChevronLeft />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Next group  ]" title="Next group  ]" disabled={!onNext} onClick={onNext}>
              <ChevronRight />
            </Button>
          </span>
        </div>
        <h3 className="text-base leading-snug font-semibold">{section.title}</h3>
        {section.summary ? <LinkedMarkdown className="text-sm text-muted-foreground">{section.summary}</LinkedMarkdown> : null}
        {section.layers.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {section.layers.map((layer) => (
              <Badge key={layer} variant="outline" className="font-normal text-muted-foreground">
                {layer}
              </Badge>
            ))}
          </div>
        ) : null}
        <ul className="flex flex-col gap-0.5 pt-1" aria-label="Files in this group">
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
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={reviewed} onChange={() => onReviewed(!reviewed)} className="size-3.5" />
            Reviewed
          </label>
          {onNext ? (
            <Button
              size="sm"
              variant={reviewed ? 'outline' : 'default'}
              onClick={() => {
                if (!reviewed) onReviewed(true)
                onNext()
              }}
            >
              {reviewed ? 'Next group' : 'Mark reviewed and go on'}
            </Button>
          ) : null}
        </div>
      </aside>
      <div className="min-h-0 min-w-0">
        {changed && shown ? (
          <ContentPane
            key={`${section.id}:${shown.path}`}
            worktreeId={worktreeId}
            spec={spec}
            file={changed}
            hunks={shown.hunks}
            comments={comments.filter((comment) => comment.file === shown.path)}
            mode={mode}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * Groups: the change split by Claude into the features it is made of. The overview shows how they
 * fit together; reviewing goes one group at a time, one file at a time, each file showing only
 * that group's share of it — or the whole file, when the context is wanted.
 */
export function GroupsView({
  worktreeId,
  against,
  files,
  groups,
  comments,
  mode,
  onOpenRef
}: {
  worktreeId: string
  against: Against
  /** The diff as Changes lists it, to tell whether the groups are older than it. */
  files: ChangedFile[]
  groups: Groups
  comments: ReviewComment[]
  mode: DiffMode
  onOpenRef: OpenFileRef
}): React.JSX.Element {
  const spec: DiffSpec = useMemo(() => ({ kind: 'worktree', against }), [against])
  const result = groups.result
  const sections = useMemo(() => (result ? reviewSections(result.groups) : []), [result])
  const uncommitted = useMemo(() => comments.filter((c) => !c.commitSha), [comments])
  const isReviewed = (section: ReviewSection): boolean => groups.reviewed.has(reviewedKey(section.refs))
  const cards = useMemo(() => (result ? featureCards(result.groups, sections, files, groups.reviewed) : []), [result, sections, files, groups.reviewed])
  const done = sections.filter(isReviewed).length
  const stale = result !== undefined && files.length > 0 && isStale(result, files)

  const [view, setView] = useState<View>('overview')
  const [current, setCurrent] = useState(0)
  // A new grouping starts over at its overview.
  useEffect(() => {
    setView('overview')
    setCurrent(0)
  }, [result])
  const go = (index: number): void => setCurrent(Math.max(0, Math.min(sections.length - 1, index)))
  const at = Math.min(current, Math.max(0, sections.length - 1))
  const section = sections[at]
  useHotkeys(view === 'review' ? { '[': () => go(at - 1), ']': () => go(at + 1) } : {})

  return (
    <FileRefLinks onOpen={onOpenRef}>
      <div className="flex min-h-0 flex-1 flex-col">
        <GroupBar key={`${worktreeId}:${against}`} groups={groups} done={done} total={sections.length} stale={stale} />
        {groups.error ? (
          <div className="px-4 pt-3">
            <ErrorNote error={groups.error} />
          </div>
        ) : null}
        {sections.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{groups.running ? 'The Git Agent is reading the change…' : 'Read this change one feature at a time'}</p>
            <p>
              {groups.running
                ? 'Follow along in its Grouping tab. The groups appear here as soon as it answers, and asking it there to merge or split groups updates them.'
                : files.length === 0
                  ? 'There is nothing to group yet: this worktree has no changes.'
                  : `An agent sorts the ${files.length} changed files into features, each with its frontend, backend and data parts together, and orders them so the foundations come first. It works in a Git Agent tab, where you can ask it to change the groups.`}
            </p>
          </div>
        ) : (
          <>
            <Navigator view={view} onView={setView} sections={sections} current={at} onGo={go} isReviewed={isReviewed} />
            {view === 'overview' ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Overview
                  cards={cards}
                  links={result?.links ?? []}
                  current={section ? cards.find((card) => section.number === card.number || section.number.startsWith(`${card.number}.`))?.id : undefined}
                  onOpen={(card) => {
                    go(card.first)
                    setView('review')
                  }}
                />
              </div>
            ) : section ? (
              <SectionView
                key={section.id}
                worktreeId={worktreeId}
                spec={spec}
                section={section}
                total={result?.groups.length ?? 0}
                files={files}
                reviewed={isReviewed(section)}
                onReviewed={(on) => groups.setReviewed(reviewedKey(section.refs), on)}
                onPrev={at > 0 ? () => go(at - 1) : undefined}
                onNext={at < sections.length - 1 ? () => go(at + 1) : undefined}
                comments={uncommitted}
                mode={mode}
              />
            ) : null}
          </>
        )}
      </div>
    </FileRefLinks>
  )
}
