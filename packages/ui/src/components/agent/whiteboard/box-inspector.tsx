import { useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, CircleHelp, FileCode2, FileDiff, Layers, Lightbulb, StickyNote, X } from 'lucide-react'

import { boxKey, PART_STATUS, type ProgressStatus } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { STATUS } from '@/components/ui/change-map/diagram-parts'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { Textarea } from '@/components/ui/textarea'
import { refTarget, type BoxInfo, type ThreadEntry } from '@/lib/whiteboard'
import { cn } from '@/lib/utils'

import { STATUS_LABELS } from './board-drawing'
import { Drawer } from './drawer'

const PROGRESS_WORD: Record<ProgressStatus, string> = {
  doing: 'In progress',
  done: 'Done'
}

export interface BoxInspectorProps {
  info: BoxInfo
  /** The questions asked about this box and what the agent answered. */
  thread: ThreadEntry[]
  /** A turn is running: asking queues behind it rather than starting another. */
  busy: boolean
  /** The running turn has no board tools, so asking and going deeper wait for it to end. */
  waiting?: boolean
  onAsk: (question: string) => void
  /** Has the agent write the box up on the whiteboard as a detail board; the question is optional. */
  onDraw: (question: string) => void
  /** A passage selected in this drawer, waiting in the ask bar as context for the next question. */
  quote?: string
  onDropQuote?: () => void
  /** Shows the detail board the box already has. */
  onOpenDetail: () => void
  /** Opens a `path:lines` reference; absent where nothing opens files. */
  onOpenRef?: (ref: string) => void
  /** Shows what the build changed in these files; offered on a box marked done. */
  onShowChanges?: (files: string[]) => void
  /** The reader's own notes on this box, kept until sent with the rest. */
  notes: readonly string[]
  onAddNote: (note: string) => void
  onRemoveNote: (index: number) => void
  onClose: () => void
  className?: string
}

export const Section = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }): React.JSX.Element => (
  <section className="flex flex-col gap-1.5">
    <h4 className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5">
      {icon}
      {title}
    </h4>
    {children}
  </section>
)

export function Thread({ thread }: { thread: ThreadEntry[] }): React.JSX.Element | null {
  if (thread.length === 0) return null
  return (
    <Section icon={<CircleHelp />} title={`Questions (${thread.length})`}>
      <ol className="flex flex-col gap-3">
        {thread.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-1.5">
            <div className="self-end rounded-xl rounded-br-sm bg-primary px-3 py-1.5">
              {/* The bubble's own colours, not the markdown's: it sits on primary in either theme. */}
              <MessageMarkdown className="text-[13px] leading-relaxed text-primary-foreground [&_blockquote]:my-1 [&_blockquote]:border-primary-foreground/40 [&_blockquote]:text-primary-foreground/75">{entry.question}</MessageMarkdown>
            </div>
            <div className="rounded-xl rounded-bl-sm bg-muted/60 px-3 py-2 text-[13px] leading-relaxed">
              {entry.answer ? <MessageMarkdown>{entry.answer}</MessageMarkdown> : <span className="text-muted-foreground">Answering…</span>}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}

/** Notes the reader pins on the box while reading; they go to the agent together, from the toolbar. */
function Notes({ notes, onAdd, onRemove }: { notes: readonly string[]; onAdd: (note: string) => void; onRemove: (index: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    if (!draft.trim()) return
    onAdd(draft.trim())
    setDraft('')
  }
  return (
    <Section icon={<StickyNote />} title={notes.length > 0 ? `Your notes (${notes.length})` : 'Your notes'}>
      {notes.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {notes.map((note, index) => (
            <li key={index} className="group flex items-start gap-2 rounded-md bg-nessa-attention/10 px-2.5 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1">{note}</span>
              <button type="button" aria-label="Remove this note" onClick={() => onRemove(index)} className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground [&_svg]:size-3.5">
                <X />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
          placeholder="Pin a note on this box…"
          aria-label="A note on this box"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <Button variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
          Pin
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Notes wait here until you send them all from the toolbar.</p>
    </Section>
  )
}

const ASK_HINT = { waiting: 'Wait for the current answer to finish', busy: 'Sent after the current answer finishes', idle: 'Enter to send · Shift+Enter for a new line' }

/** A question asked with a passage as its context, as the agent and the thread both read it. */
export const withQuote = (quote: string | undefined, question: string): string => (quote ? `${quote.replace(/^/gm, '> ')}\n\n${question}` : question)

/**
 * Asking about something on the whiteboard. A passage staged as `quote` rides along with the next
 * question, shown above the field until sent or dropped. A question is answered in words; with `onDraw`, the
 * "Draw in whiteboard" switch has the agent write it up on the board instead, the question then
 * optional. The switch is off by default and turns itself off again once sent, so a board is only
 * ever drawn when asked for.
 */
export function AskBox({
  label,
  busy,
  waiting = false,
  onAsk,
  onDraw,
  quote,
  onDropQuote
}: {
  label: string
  busy: boolean
  waiting?: boolean
  onAsk: (question: string) => void
  onDraw?: (question: string) => void
  quote?: string
  onDropQuote?: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  // A passage just staged is asked about next, so the cursor goes where the question is typed.
  useEffect(() => {
    if (quote) field.current?.focus()
  }, [quote])
  const [drawing, setDrawing] = useState(false)
  const switchId = useId()
  const question = draft.trim()
  const ready = !waiting && (drawing || question !== '')
  const send = (): void => {
    if (!ready) return
    if (drawing && onDraw) onDraw(withQuote(quote, question))
    else onAsk(withQuote(quote, question))
    setDraft('')
    setDrawing(false)
    onDropQuote?.()
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {quote ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 py-1.5 pr-1.5 pl-2.5">
          <blockquote className="line-clamp-3 min-w-0 flex-1 border-l-2 border-foreground/30 pl-2 text-xs leading-relaxed text-foreground/80 italic">{quote}</blockquote>
          {onDropQuote ? (
            <button type="button" aria-label="Remove the quoted passage" onClick={onDropQuote} className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5">
              <X />
            </button>
          ) : null}
        </div>
      ) : null}
      <Textarea
        ref={field}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          }
        }}
        placeholder={drawing ? 'Anything the drawing should answer? (optional)' : `Ask about ${label}…`}
        aria-label={`Ask about ${label}`}
        rows={2}
        className="min-h-16 resize-none text-[13px]"
      />
      <div className="flex items-center gap-3">
        {onDraw ? (
          <label htmlFor={switchId} className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
            <Switch id={switchId} checked={drawing} onCheckedChange={setDrawing} />
            Draw in whiteboard
          </label>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">{ASK_HINT[waiting ? 'waiting' : busy ? 'busy' : 'idle']}</span>
        <Button type="submit" size="sm" disabled={!ready}>
          {drawing ? 'Draw' : 'Ask'}
        </Button>
      </div>
    </form>
  )
}

/**
 * Everything about one box, beside the board: what it is in plain words, why the plan does what it
 * does, where its code is, what was asked about it — and the ask bar below, which answers in words
 * or, switched to drawing, has the agent write the box up on the whiteboard.
 */
export function BoxInspector({ info, thread, busy, waiting = false, onAsk, onDraw, quote, onDropQuote, onOpenDetail, onOpenRef, onShowChanges, notes, onAddNote, onRemoveNote, onClose, className }: BoxInspectorProps): React.JSX.Element {
  const status = PART_STATUS[info.note?.status ?? 'context']
  const title = (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS[status].card)}>{STATUS_LABELS[status]}</span>
        {info.progress ? (
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', info.progress === 'done' ? 'bg-nessa-diff-addition/15 text-nessa-diff-addition' : 'bg-muted text-foreground')}>
            {PROGRESS_WORD[info.progress]}
          </span>
        ) : null}
      </div>
      <h3 className="mt-1.5 text-base leading-snug font-semibold">{info.node.label}</h3>
    </>
  )
  return (
    <Drawer label={`About ${info.node.label}`} title={title} onClose={onClose} footer={<AskBox key={boxKey(info.ref)} label={info.node.label} busy={busy} waiting={waiting} onAsk={onAsk} onDraw={onDraw} quote={quote} onDropQuote={onDropQuote} />} className={className}>
      <>
        {info.note ? <p className="text-sm leading-relaxed">{info.note.explain}</p> : <p className="text-sm text-muted-foreground">The agent has not explained this box yet.</p>}
        {info.note?.why ? (
          <Section icon={<Lightbulb />} title="Why this way">
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px] leading-relaxed">{info.note.why}</p>
          </Section>
        ) : null}
        {info.refs.length > 0 ? (
          <Section icon={<FileCode2 />} title="Where it lives">
            <ul className="flex flex-col gap-1">
              {info.refs.map((ref) => {
                const { path, lines } = refTarget(ref)
                const slash = path.lastIndexOf('/')
                return (
                  <li key={ref}>
                    <button
                      type="button"
                      disabled={!onOpenRef}
                      onClick={() => onOpenRef?.(ref)}
                      title={onOpenRef ? `Open ${ref}` : ref}
                      className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left enabled:hover:bg-accent"
                    >
                      <span className="truncate font-mono text-xs">
                        {path.slice(slash + 1)}
                        {lines ? <span className="text-muted-foreground">:{lines}</span> : null}
                      </span>
                      {slash > 0 ? <span className="truncate text-[11px] text-muted-foreground">{path.slice(0, slash)}</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </Section>
        ) : null}
        {info.progress === 'done' && onShowChanges ? (
          <Button variant="outline" size="sm" className="justify-between" onClick={() => onShowChanges(info.refs.map((ref) => refTarget(ref).path))}>
            See what the build changed <FileDiff />
          </Button>
        ) : null}
        {info.detail ? (
          <Section icon={<Layers />} title="Go deeper">
            <Button variant="outline" size="sm" className="justify-between" onClick={onOpenDetail}>
              Show what is inside <ArrowRight />
            </Button>
          </Section>
        ) : null}
        <Notes notes={notes} onAdd={onAddNote} onRemove={onRemoveNote} />
        <Thread thread={thread} />
      </>
    </Drawer>
  )
}
