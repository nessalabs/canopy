import { Compass, Presentation, Route } from 'lucide-react'

import type { WhiteboardMode } from '@canopy/shared'

import { MODE_WORD } from '@/lib/whiteboard'
import { cn } from '@/lib/utils'

const STARTERS: Array<{
  mode: WhiteboardMode
  icon: React.ReactNode
  title: string
  hint: string
  example: string
}> = [
  {
    mode: 'explain',
    icon: <Compass />,
    title: 'Explain a feature',
    hint: 'How does something in this codebase work? The agent reads the code and draws it.',
    example: 'Explain what happens when someone signs in.'
  },
  {
    mode: 'plan',
    icon: <Route />,
    title: 'Plan a change',
    hint: 'Describe what you want built. You approve the plan on the board before any code changes.',
    example: 'Plan letting customers use discount codes at checkout.'
  }
]

/** An empty whiteboard says what it is for, and starts either kind of conversation. */
export function EmptyBoard({ mode, onMode }: { mode?: WhiteboardMode; onMode: (mode: WhiteboardMode) => void }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto p-6 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-6">
        <Presentation />
      </span>
      <div className="max-w-md">
        <p className="text-base font-semibold">The whiteboard</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The agent draws its answer here as boards you can click into: the big picture first, then any box opened up as its own board, with plain-words notes and the code behind it.
        </p>
      </div>
      <div className="grid w-full max-w-xl gap-3 sm:grid-cols-2">
        {STARTERS.map((starter) => (
          <button
            key={starter.mode}
            type="button"
            onClick={() => onMode(starter.mode)}
            aria-pressed={mode === starter.mode}
            className={cn(
              'flex flex-col gap-1.5 rounded-xl border bg-card p-4 text-left transition-colors outline-none hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/40',
              mode === starter.mode ? 'border-foreground/40 ring-1 ring-foreground/10' : 'border-border'
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4">
              {starter.icon}
              {starter.title}
            </span>
            <span className="text-xs text-muted-foreground">{starter.hint}</span>
            <span className="mt-1 text-[11px] text-muted-foreground/80 italic">“{starter.example}”</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{mode ? `${MODE_WORD[mode]} is on — type your question in the composer.` : 'Pick one, then type in the composer.'}</p>
    </div>
  )
}
