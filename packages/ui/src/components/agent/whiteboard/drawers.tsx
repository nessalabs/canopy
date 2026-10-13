import { CheckCheck, CircleHelp, FileCode2, MessageCircleQuestion, Quote, Scale } from 'lucide-react'

import type { PlanView } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'

import { quoteAsks, refsOfLink, threadOf, trailOf, type TrailEntry } from '@/lib/whiteboard'

import { AskBox, Section, Thread } from './box-inspector'
import { Drawer } from './drawer'

/** Where a passage was selected, in words: a board by its title, or the plan document. */
const placeOf = (view: PlanView, ref: string): string => (ref === 'plan' ? 'the plan document' : `the board “${view.state.boards[ref]?.versions.at(-1)?.title ?? ref}”`)

/**
 * A passage the reader selected and asked about: the passage, what the agent made of it (asked in
 * the same session, so it answers from what it already read), and room for a follow-up.
 */
export function AskDrawer({
  view,
  turns,
  quote,
  refId,
  busy,
  waiting,
  onAsk,
  onClose,
  className
}: {
  view: PlanView
  turns: readonly Turn[]
  quote: string
  refId: string
  busy: boolean
  /** The running turn has no board tools, so asking has to wait for it to end. */
  waiting?: boolean
  onAsk: (question: string) => void
  onClose: () => void
  className?: string
}): React.JSX.Element {
  const thread = threadOf(turns, quoteAsks(view.asked, refId, quote))
  return (
    <Drawer
      label="About the selected passage"
      title={<p className="text-sm font-semibold">About this passage</p>}
      onClose={onClose}
      footer={<AskBox label="this passage" busy={busy} waiting={waiting} onAsk={onAsk} />}
      className={className}
    >
      <Section icon={<Quote />} title={`From ${placeOf(view, refId)}`}>
        <blockquote className="border-l-2 border-foreground/30 pl-3 text-[13px] leading-relaxed text-foreground/90 italic">{quote}</blockquote>
      </Section>
      {thread.length > 0 ? <Thread thread={thread} /> : <p className="text-[13px] text-muted-foreground">Asking the agent…</p>}
    </Drawer>
  )
}

const ICON: Record<TrailEntry['kind'], React.ReactNode> = {
  'you-asked': <CircleHelp />,
  'claude-asked': <MessageCircleQuestion />,
  decision: <Scale />
}

const WHO: Record<TrailEntry['kind'], string> = { 'you-asked': 'You asked', 'claude-asked': 'Claude asked you', decision: 'Decision on the board' }

/** One step of the trail: who asked what, what came of it, and — once built — where it lives in the code. */
function TrailItem({ entry, onOpenRef }: { entry: TrailEntry; onOpenRef?: (ref: string) => void }): React.JSX.Element {
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      <span className="relative z-10 mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground [&_svg]:size-3.5">{ICON[entry.kind]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{WHO[entry.kind]}</p>
        <p className="text-[13px] font-medium">{entry.question}</p>
        {entry.answer ? <p className="text-[13px] text-foreground/90">→ {entry.answer}</p> : <p className="text-[13px] text-muted-foreground">Not answered yet</p>}
        {entry.built ? (
          <div className="rounded-md border border-nessa-diff-addition/40 bg-nessa-diff-addition/5 px-2.5 py-2 text-[13px]">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-nessa-diff-addition [&_svg]:size-3.5">
              <CheckCheck aria-hidden="true" /> Built
            </p>
            <p className="mt-0.5">{entry.built.how}</p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {refsOfLink(entry.built).map((ref) => (
                <li key={ref}>
                  <button
                    type="button"
                    disabled={!onOpenRef}
                    onClick={() => onOpenRef?.(ref)}
                    className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] enabled:hover:bg-accent [&_svg]:size-3"
                  >
                    <FileCode2 aria-hidden="true" /> {ref}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Every question and decision of the session in order — what the reader asked, what Claude asked
 * them, which way they chose — and, once the code is written, how each choice was built and where.
 */
export function TrailDrawer({ view, turns, onOpenRef, onClose, className }: { view: PlanView; turns: readonly Turn[]; onOpenRef?: (ref: string) => void; onClose: () => void; className?: string }): React.JSX.Element {
  const trail = trailOf(view, turns)
  return (
    <Drawer label="Decision trail" title={<p className="text-sm font-semibold">Decision trail</p>} onClose={onClose} className={className}>
      {trail.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Questions you ask, questions Claude asks you, and the choices you make show up here — and, once built, where each one lives in the code.</p>
      ) : (
        <ol className="relative before:absolute before:top-3 before:bottom-3 before:left-3 before:w-px before:bg-border">
          {trail.map((entry) => (
            <TrailItem key={entry.key} entry={entry} onOpenRef={onOpenRef} />
          ))}
        </ol>
      )}
    </Drawer>
  )
}

/** A board's details in the sidebar: what it shows and why, today against after, versions, decisions. */
export function BoardDrawer({ children, onClose, className }: { children: React.ReactNode; onClose: () => void; className?: string }): React.JSX.Element {
  return (
    <Drawer label="About this board" title={<p className="text-sm font-semibold">About this board</p>} onClose={onClose} className={className}>
      {children}
    </Drawer>
  )
}
