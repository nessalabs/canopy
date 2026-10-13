import { Check } from 'lucide-react'

import { QuestionnaireProgress } from '@/components/ui/questionnaire'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export interface Step {
  key: string
  /** A few words naming the step on its tab. */
  label: string
  /** Answered: its tab says so. */
  done: boolean
}

/**
 * Several questions asked one at a time: a tab per question, naming it and ticking it once
 * answered, and the one on screen below. Jumping between tabs is free; `children` draws the
 * question at `index`, its own Next/Back included.
 */
export function StepTabs({ steps, index, onIndex, children }: { steps: readonly Step[]; index: number; onIndex: (index: number) => void; children: (index: number) => React.ReactNode }): React.JSX.Element {
  if (steps.length === 1) return <>{children(0)}</>
  return (
    <Tabs value={steps[index]?.key} onValueChange={(key) => onIndex(Math.max(0, steps.findIndex((step) => step.key === key)))}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList className="max-w-full overflow-x-auto">
          {steps.map((step, at) => (
            <TabsTrigger key={step.key} value={step.key} className="gap-1.5 text-xs">
              <span className="tabular-nums text-muted-foreground">{at + 1}</span>
              <span className="max-w-40 truncate">{step.label}</span>
              {step.done ? <Check className="size-3.5 text-nessa-diff-addition" aria-label="answered" /> : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <QuestionnaireProgress step={index + 1} total={steps.length} />
      </div>
      {steps.map((step, at) => (
        <TabsContent key={step.key} value={step.key} className="mt-3">
          {at === index ? children(at) : null}
        </TabsContent>
      ))}
    </Tabs>
  )
}

/** The step after `index` still to be answered, else the next one, else none. */
export const nextOpen = (steps: readonly Step[], index: number): number | undefined => {
  const later = steps.findIndex((step, at) => at > index && !step.done)
  if (later !== -1) return later
  return index + 1 < steps.length ? index + 1 : undefined
}
