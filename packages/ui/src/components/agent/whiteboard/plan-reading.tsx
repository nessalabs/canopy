import { useRef } from 'react'

import { draftPlan, type PermissionDecisionInput } from '@canopy/shared'

import type { Whiteboard } from '@/lib/use-whiteboard'

import { SelectionActions } from '../selection-actions'
import { PlanApproval, planOf } from './plan-approval'
import { PlanDocument } from './plan-document'

/** The plan there is to read: the one the agent asked approval with, else what its boards say so far. Explaining draws boards too, but plans nothing. */
export const planText = ({ view, approval, mode }: Whiteboard): string => view.document || (approval && planOf(approval)) || (mode === 'explain' ? '' : draftPlan(view.state))

/**
 * The plan in the Reader, beside the whiteboard rather than over it, so a box and the plan can be
 * read at once. While the plan waits for approval, it is answered from under the plan; a selected
 * passage is asked about as it is on the board.
 */
export function PlanReading({ whiteboard, onAnswer }: { whiteboard: Whiteboard; onAnswer: (input: PermissionDecisionInput) => void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const text = planText(whiteboard)
  return (
    <div ref={root} className="flex h-full min-h-0 flex-col">
      <SelectionActions host={root} onAsk={(passage) => whiteboard.quote('plan', passage)} askLabel="Ask the agent" askHint="Explain what this is and how it fits in" />
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {text ? <PlanDocument text={text} defaultOpen fill /> : <p className="text-xs text-muted-foreground">No plan yet — it appears once the agent draws its first board.</p>}
      </div>
      {whiteboard.approval ? (
        <footer className="border-t border-border px-4 py-3">
          <PlanApproval ask={whiteboard.approval} onAnswer={onAnswer} beside className="border-0 bg-transparent p-0 shadow-none" />
        </footer>
      ) : null}
    </div>
  )
}
