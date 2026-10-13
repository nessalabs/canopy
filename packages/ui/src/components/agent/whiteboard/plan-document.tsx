import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'

import { MessageMarkdown } from '@/components/ui/message-markdown'
import { cn } from '@/lib/utils'

/**
 * The plan document the agent wrote, folded by default. Its header — and the control that folds it
 * again — stays in place however long the plan is: the open body scrolls inside a bounded box
 * rather than pushing what is around it off screen. `data-plan-doc` lets a passage selected in it
 * be asked about.
 */
export function PlanDocument({ text, defaultOpen = false, fill = false, className }: {
  text: string
  defaultOpen?: boolean
  /** Fill the space it is given (a drawer) instead of holding to a bounded height (a card in the chat). */
  fill?: boolean
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const heading = /^#\s+(.+)$/m.exec(text)?.[1] ?? 'Plan document'
  return (
    <section data-plan-doc className={cn('flex min-h-0 flex-col rounded-lg border border-border bg-background/60', fill && open && 'flex-1', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground/90 hover:bg-accent/50 [&_svg]:size-3.5 [&_svg]:shrink-0"
      >
        <FileText className="text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{heading}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {open ? 'Hide' : 'Read the plan'}
          {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </span>
      </button>
      {open ? (
        <div className={cn('overflow-y-auto border-t border-border px-4 py-3 text-[13px] leading-relaxed', fill ? 'min-h-0 flex-1' : 'max-h-[min(55vh,32rem)]')}>
          <MessageMarkdown>{text}</MessageMarkdown>
        </div>
      ) : null}
    </section>
  )
}
