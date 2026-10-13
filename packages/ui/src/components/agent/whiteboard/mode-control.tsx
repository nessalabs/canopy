import { Check, Compass, Hammer, Presentation, Route } from 'lucide-react'

import type { WhiteboardMode } from '@canopy/shared'

import { ChatComposerAction } from '@/components/ui/chat-composer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface Choice {
  mode: WhiteboardMode | undefined
  icon: React.ReactNode
  label: string
  hint: string
  /** What the composer's input invites while this mode is on. */
  placeholder?: string
}

const CHOICES: readonly Choice[] = [
  {
    mode: undefined,
    icon: <Presentation />,
    label: 'Off',
    hint: 'An ordinary conversation in the chat.'
  },
  {
    mode: 'explain',
    icon: <Compass />,
    label: 'Explain',
    hint: 'Draws how a feature works, for you to click into.',
    placeholder: 'What should the agent explain? It answers on the whiteboard'
  },
  {
    mode: 'plan',
    icon: <Route />,
    label: 'Plan',
    hint: 'Plans a change on the whiteboard; nothing is edited until you approve.',
    placeholder: 'What should the agent plan? You approve it on the whiteboard'
  }
]

const BUILD: Choice = {
  mode: 'build',
  icon: <Hammer />,
  label: 'Build',
  hint: 'Builds the approved plan and marks each box as it goes.',
  placeholder: 'Steer the build, or ask about a box'
}

const choiceOf = (mode: WhiteboardMode | undefined): Choice => (mode === 'build' ? BUILD : (CHOICES.find((choice) => choice.mode === mode) ?? CHOICES[0]!))

/** The composer's invitation while a whiteboard mode is on; undefined leaves the usual one. */
export const modePlaceholder = (mode: WhiteboardMode | undefined): string | undefined => choiceOf(mode).placeholder

/**
 * The composer's whiteboard switch: off, explain or plan. While a plan is being built it says so,
 * and turning it off returns the conversation to the chat alone.
 */
export function WhiteboardModeControl({ value, onValueChange }: { value: WhiteboardMode | undefined; onValueChange: (mode: WhiteboardMode | undefined) => void }): React.JSX.Element {
  const current = choiceOf(value)
  const choices = value === 'build' ? [...CHOICES, BUILD] : CHOICES
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChatComposerAction
          aria-label={value ? `Whiteboard: ${current.label}` : 'Whiteboard'}
          title={value ? `Whiteboard: ${current.label}` : 'Answer on the whiteboard'}
          className={cn(value && 'w-auto gap-1.5 bg-accent px-3 text-xs font-medium text-foreground')}
        >
          {current.icon}
          {value ? <span>{current.label}</span> : null}
        </ChatComposerAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Whiteboard</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {choices.map((choice) => (
          <DropdownMenuItem key={choice.label} onSelect={() => onValueChange(choice.mode)} className="items-start gap-2.5 py-2">
            <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{choice.icon}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm">{choice.label}</span>
              <span className="text-xs text-muted-foreground">{choice.hint}</span>
            </span>
            {choice.mode === value ? <Check className="mt-0.5 size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
