import { useMemo, useState } from 'react'
import { Check, Image, Scale } from 'lucide-react'

import { graphDrawing, parseMermaid, type Choice, type Decision, type DecisionOption } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import { nextOpen, StepTabs } from '../step-tabs'
import { BoardDrawing } from './board-drawing'

/** An option's small picture of how things would work with it, folded until asked for. */
function OptionPicture({ mermaid }: { mermaid: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const drawing = useMemo(() => graphDrawing(parseMermaid(mermaid).graph), [mermaid])
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
        <Image aria-hidden="true" /> {open ? 'Hide the picture' : 'See how it would work'}
      </button>
      {open ? <BoardDrawing drawing={drawing} className="mt-2" /> : null}
    </div>
  )
}

function OptionCard({ option, picked, chosen, disabled, onPick }: { option: DecisionOption; picked: boolean; chosen: boolean; disabled: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <div className={cn('rounded-lg border bg-background p-3 transition-colors', picked ? 'border-foreground/50 ring-1 ring-foreground/15' : 'border-border', disabled && !chosen && 'opacity-50')}>
      <button type="button" disabled={disabled} onClick={onPick} aria-pressed={picked} className="flex w-full items-start gap-2 text-left">
        <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', picked ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/60')}>
          {picked ? <Check className="size-3" aria-hidden="true" /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {option.label}
            {option.recommended ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Recommended</span> : null}
          </span>
          <span className="text-[13px] leading-relaxed text-muted-foreground">{option.explain}</span>
        </span>
      </button>
      {option.mermaid ? <OptionPicture mermaid={option.mermaid} /> : null}
    </div>
  )
}

interface Pick {
  option?: string
  note: string
}

/** One decision: what it is about, the options to weigh, a note — or, once sent, the choice made. */
function DecisionView({ decision, pick, onPick }: { decision: Decision; pick: Pick; onPick: (pick: Pick) => void }): React.JSX.Element {
  const answered = decision.answer !== undefined
  const shown = decision.answer?.option ?? pick.option
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-semibold">{decision.question}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{decision.context}</p>
      </div>
      <div className="flex flex-col gap-2">
        {decision.options.map((candidate) => (
          <OptionCard key={candidate.id} option={candidate} picked={shown === candidate.id} chosen={decision.answer?.option === candidate.id} disabled={answered} onPick={() => onPick({ ...pick, option: candidate.id })} />
        ))}
      </div>
      {answered ? (
        <p className="text-xs text-muted-foreground">
          You chose <span className="font-medium text-foreground">{decision.options.find((candidate) => candidate.id === decision.answer!.option)?.label}</span>
          {decision.answer!.note ? ` — “${decision.answer!.note}”` : ''}
        </p>
      ) : (
        <Textarea value={pick.note} onChange={(event) => onPick({ ...pick, note: event.target.value })} placeholder="Anything to add? (optional)" aria-label="A note with your choice" rows={2} className="min-h-12 resize-none text-[13px]" />
      )}
    </div>
  )
}

/** A decision's starting pick: the agent's recommendation, so a reader who agrees only has to send. */
const startingPick = (decision: Decision): Pick => ({ option: decision.options.find((option) => option.recommended)?.id, note: '' })

/**
 * The decisions the agent put on a board, one at a time on tabs: each explains itself and every
 * option says what it changes, with a picture of it when the agent drew one. Choices collect here
 * and go back together in one message, in the same session, so the agent carries on once with all
 * of them.
 */
export function DecisionDeck({ decisions, onSend, className, ...props }: {
  decisions: readonly Decision[]
  /** False when the choices could not be sent yet, so the button stays live. */
  onSend: (choices: Choice[]) => boolean
  className?: string
} & React.ComponentProps<'section'>): React.JSX.Element | null {
  const [index, setIndex] = useState(() => Math.max(0, decisions.findIndex((decision) => !decision.answer)))
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  // What was sent, by the decisions it answered: the button stays off until their answers come back.
  const [sentFor, setSentFor] = useState<string>()
  if (decisions.length === 0) return null
  const pickOf = (decision: Decision): Pick => picks[decision.id] ?? startingPick(decision)
  const open = decisions.filter((decision) => !decision.answer)
  const sent = sentFor === open.map((decision) => decision.id).join()
  const ready = open.filter((decision) => pickOf(decision).option)
  const steps = decisions.map((decision) => ({ key: decision.id, label: decision.question, done: decision.answer !== undefined }))
  const at = Math.min(index, decisions.length - 1)
  const next = nextOpen(steps, at)
  const send = (): void => {
    const choices = ready.map((decision) => {
      const { option, note } = pickOf(decision)
      const chosen = decision.options.find((candidate) => candidate.id === option)!
      return { id: decision.id, question: decision.question, option: chosen.id, label: chosen.label, note: note.trim() }
    })
    if (onSend(choices)) setSentFor(open.map((decision) => decision.id).join())
  }
  return (
    <section {...props} aria-label="Decisions for you" className={cn('flex flex-col gap-3 rounded-xl border border-nessa-attention/40 bg-nessa-attention/5 p-3', className)}>
      <h4 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5">
        <Scale aria-hidden="true" /> {open.length > 0 ? `${open.length} ${open.length === 1 ? 'decision' : 'decisions'} for you` : 'Your decisions'}
      </h4>
      <StepTabs steps={steps} index={at} onIndex={setIndex}>
        {(shown) => <DecisionView decision={decisions[shown]!} pick={pickOf(decisions[shown]!)} onPick={(pick) => setPicks((current) => ({ ...current, [decisions[shown]!.id]: pick }))} />}
      </StepTabs>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {at > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setIndex(at - 1)}>
            Back
          </Button>
        ) : null}
        {next !== undefined ? (
          <Button variant="ghost" size="sm" onClick={() => setIndex(next)}>
            Next
          </Button>
        ) : null}
        {open.length > 0 ? (
          <Button size="sm" disabled={sent || ready.length === 0} onClick={send}>
            {sent ? 'Sent' : ready.length === open.length ? `Send my ${open.length === 1 ? 'decision' : 'decisions'}` : `Send ${ready.length} of ${open.length}`}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
