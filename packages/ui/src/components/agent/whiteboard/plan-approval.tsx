import { useState } from 'react'
import { ClipboardCheck, FileText, X } from 'lucide-react'

import type { PermissionDecisionInput } from '@canopy/shared'
import type { AgentEvent } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import { PlanDocument } from './plan-document'

/** The plan an `ExitPlanMode` ask carries. */
export const planOf = (ask: AgentEvent): string => {
  const plan = isEvent(ask, AgentEventType.PermissionRequested) ? (ask.payload.input as { plan?: unknown } | null)?.plan : undefined
  return typeof plan === 'string' ? plan : ''
}

/**
 * The agent asking to leave plan mode: the plan is on the whiteboard, and approving it lets the
 * same turn start building with edit access. Keeping planning sends what should change instead.
 * Shown on the board and in the conversation; whichever is answered first settles both.
 *
 * In the conversation the plan document folds open in place; on the whiteboard `onReadPlan` opens
 * it beside the boards instead, so it never pushes them off screen, and `onDismiss` puts the card
 * away. Under the plan it reads `beside` it: no copy of the plan, no way to open it.
 */
export function PlanApproval({
  ask,
  onAnswer,
  onReadPlan,
  onDismiss,
  beside = false,
  className
}: {
  ask: AgentEvent
  onAnswer: (input: PermissionDecisionInput) => void
  onReadPlan?: () => void
  onDismiss?: () => void
  beside?: boolean
  className?: string
}): React.JSX.Element | null {
  const [answered, setAnswered] = useState<'approved' | 'revising' | null>(null)
  const [revising, setRevising] = useState(false)
  const [note, setNote] = useState('')
  if (!isEvent(ask, AgentEventType.PermissionRequested)) return null
  const { requestId } = ask.payload
  const plan = planOf(ask)

  const approve = (): void => {
    setAnswered('approved')
    onAnswer({ requestId, behavior: 'allow', autonomy: 'edit' })
  }
  const keepPlanning = (): void => {
    setAnswered('revising')
    const wanted = note.trim()
    onAnswer({ requestId, behavior: 'deny', message: wanted ? `Not yet — keep planning. The user wants: ${wanted}` : 'Not yet — keep planning. Ask the user what should change.' })
  }

  return (
    <section aria-label="Plan ready for review" className={cn('flex flex-col gap-3 rounded-xl border border-foreground/15 bg-card p-3 text-card-foreground shadow-sm', className)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-4">
          <ClipboardCheck />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">The plan is ready for your review</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Read the boards, then approve to let the agent build it, or say what should change.</p>
        </div>
        {plan && onReadPlan ? (
          <Button variant="outline" size="sm" onClick={onReadPlan} className="shrink-0">
            <FileText /> Read the plan
          </Button>
        ) : null}
        {onDismiss ? (
          <Button variant="ghost" size="icon" aria-label="Hide — approve from the plan instead" title="Hide — approve from the plan instead" onClick={onDismiss} className="size-8 shrink-0 text-muted-foreground">
            <X />
          </Button>
        ) : null}
      </div>
      {plan && !onReadPlan && !beside ? <PlanDocument text={plan} /> : null}
      {revising ? (
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What should change before you approve?"
          aria-label="What should change"
          rows={2}
          className="min-h-14 resize-none text-[13px]"
          autoFocus
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {answered ? (
          <span className="text-xs text-muted-foreground">{answered === 'approved' ? 'Approved — building…' : 'Sent back to planning'}</span>
        ) : revising ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setRevising(false)}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={keepPlanning}>
              Send back
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setRevising(true)}>
              Keep planning
            </Button>
            <Button size="sm" onClick={approve}>
              Approve and build
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
