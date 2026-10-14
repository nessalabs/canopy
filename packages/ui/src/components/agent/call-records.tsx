import { CheckCircle2, MessageCircleQuestion, Scale } from 'lucide-react'

import { AskDecisionInput, answersIn, planToolOf, type WhiteboardMessage } from '@canopy/shared'

import { parseAskQuestions } from '@/lib/ask-questions'
import type { BeatCall } from '@/lib/turn-beats'
import { boxQuestion } from '@/lib/whiteboard'

import { PlanDocument } from './whiteboard/plan-document'

/**
 * Calls that are part of the conversation rather than work: the questions the agent asked and what
 * the reader answered, the decisions it put on the whiteboard, the plan the reader approved. The
 * transcript keeps a record of each in place, so the chat history shows what was asked and decided.
 */

const RecordCard = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }): React.JSX.Element => (
  <section className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card/60 px-3 py-2.5 text-card-foreground">
    <h4 className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5">
      {icon}
      {title}
    </h4>
    {children}
  </section>
)

function AnsweredQuestions({ call }: { call: BeatCall }): React.JSX.Element | null {
  const questions = parseAskQuestions(call.input)
  if (!questions || !call.result) return null
  const answers = call.result.isError ? {} : answersIn(call.result.text)
  return (
    <RecordCard icon={<MessageCircleQuestion />} title={questions.length === 1 ? 'Claude asked you' : `Claude asked you ${questions.length} questions`}>
      <ol className="flex flex-col gap-2">
        {questions.map((question) => (
          <li key={question.question} className="text-[13px]">
            <p className="font-medium">{question.question}</p>
            <p className={answers[question.question] ? 'text-foreground/90' : 'text-muted-foreground'}>→ {answers[question.question] ?? (call.result!.isError ? 'Skipped' : 'No answer')}</p>
          </li>
        ))}
      </ol>
    </RecordCard>
  )
}

function PostedDecision({ call }: { call: BeatCall }): React.JSX.Element | null {
  const parsed = AskDecisionInput.safeParse(call.input)
  if (!parsed.success || call.result?.isError) return null
  const { question, options } = parsed.data
  return (
    <RecordCard icon={<Scale />} title="Decision put on the whiteboard">
      <p className="text-[13px] font-medium">{question}</p>
      <ul className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <li key={option.id} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            {option.label}
            {option.recommended ? ' · recommended' : ''}
          </li>
        ))}
      </ul>
    </RecordCard>
  )
}

function ApprovedPlan({ call }: { call: BeatCall }): React.JSX.Element | null {
  const plan = (call.input as { plan?: unknown } | null)?.plan
  if (typeof plan !== 'string' || !call.result || call.result.isError) return null
  return (
    <RecordCard icon={<CheckCircle2 />} title="Plan approved">
      <PlanDocument text={plan} />
    </RecordCard>
  )
}

const RECORDS: Record<string, (props: { call: BeatCall }) => React.JSX.Element | null> = {
  AskUserQuestion: AnsweredQuestions,
  ExitPlanMode: ApprovedPlan,
  ask_decision: PostedDecision
}

/** The record a call leaves in the conversation, by its tool — a whiteboard tool by its bare name. */
const recordFor = (call: BeatCall): ((props: { call: BeatCall }) => React.JSX.Element | null) | undefined => RECORDS[planToolOf(call.name) ?? call.name]

export function CallRecords({ calls }: { calls: readonly BeatCall[] }): React.JSX.Element | null {
  const records = calls.flatMap((call) => {
    const Shown = recordFor(call)
    return Shown ? [<Shown key={call.callId} call={call} />] : []
  })
  return records.length > 0 ? <div className="flex w-full flex-col gap-2">{records}</div> : null
}

type Prompt = { about: React.ReactNode; text: string }

/** How each kind of message sent from the whiteboard reads in the transcript: a line naming what it is about, and the words. */
const PROMPTS: { [K in WhiteboardMessage['kind']]: (message: Extract<WhiteboardMessage, { kind: K }>) => Prompt } = {
  box: (box) => ({ about: `About “${box.label}”`, text: boxQuestion(box) }),
  quote: (quote) => ({ about: <span className="line-clamp-2 italic">About “{quote.quote}”</span>, text: quote.text.trim() }),
  decision: (decision) => ({
    about: decision.choices.length === 1 ? 'Your decision' : `Your ${decision.choices.length} decisions`,
    text: decision.choices.map((choice) => `${choice.question}\n→ ${choice.label}${choice.note ? ` (${choice.note})` : ''}`).join('\n\n')
  })
}

export const whiteboardPrompt = (message: WhiteboardMessage): Prompt => (PROMPTS[message.kind] as (message: WhiteboardMessage) => Prompt)(message)
