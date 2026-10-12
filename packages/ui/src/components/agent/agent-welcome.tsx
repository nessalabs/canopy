import { useState } from 'react'

import type { AgentProvider } from '@canopy/shared'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'
import { cn } from '@/lib/utils'

import { PROVIDER_NAMES, ProviderIcon } from './provider-icon'

/** One of these is the welcome's prompt line, picked once per mount. */
const CODING_LINES = [
  'git commit -m "works on my machine"',
  'Make it work, make it right, make it fast.',
  'Two hard problems: cache invalidation, naming things, and off-by-one errors.',
  'Read the diff before you trust the summary.',
  'Small commits, clear messages, fewer surprises.',
  'Every bug is a test that was never written.',
  'First, solve the problem. Then, write the code.',
  'Simplicity is prerequisite for reliability. — Dijkstra',
  'Premature optimization is the root of all evil. — Knuth',
  'Code is read far more often than it is written.',
  'rm -rf node_modules && npm install  # the ritual',
  'The best code is the code you get to delete.'
]

/** Faint tokens scattered behind the welcome, placed by hand so none sits under the text. */
const GLYPHS: { text: string; at: string }[] = [
  { text: '{ }', at: 'left-[8%] top-[14%]' },
  { text: '</>', at: 'right-[10%] top-[18%]' },
  { text: '=>', at: 'left-[14%] bottom-[22%]' },
  { text: 'git diff', at: 'right-[12%] bottom-[16%]' },
  { text: 'λ', at: 'left-[30%] top-[6%]' },
  { text: '&&', at: 'right-[28%] top-[8%]' },
  { text: 'fn()', at: 'left-[6%] top-[48%]' },
  { text: '#!', at: 'right-[6%] top-[52%]' }
]

const HINTS: { key: string; label: string }[] = [
  { key: '/', label: 'commands' },
  { key: '@', label: 'files & agents' },
  { key: '⏎', label: 'send' }
]

const titleOf = (agent: WorktreeAgent): string => {
  if (agent.fresh) return `New ${PROVIDER_NAMES[agent.fresh]} session`
  return agent.selected ? 'Ready when you are' : 'Start a session'
}

const TILE = 'grid place-items-center rounded-2xl border border-border bg-card shadow-sm transition-all duration-300 ease-out motion-reduce:transition-none'

/** How many providers get a tile of their own before the rest fold into a "+N" menu. */
const MAX_TILES = 4

/**
 * Which providers get a tile and which fold into the menu: the first `max` in order, with the
 * active one always among the tiles — it takes the last tile's place when it would be folded.
 */
export function splitProviders<T>(providers: readonly T[], active: T | undefined, max = MAX_TILES): { shown: T[]; folded: T[] } {
  if (providers.length <= max) return { shown: [...providers], folded: [] }
  const shown = providers.slice(0, max - 1)
  const last = active !== undefined && !shown.includes(active) ? active : providers[max - 1]!
  return { shown: [...shown, last], folded: providers.filter((p) => p !== last && !shown.includes(p)) }
}

/** The side slot of the i-th tile that is not picked: right, left, right, left, moving outwards. */
export const sideSlot = (index: number): number => (index % 2 === 0 ? index / 2 + 1 : -(index + 1) / 2)

/** Centre of the picked tile to centre of the first side tile, then between side tiles, in px. */
const FIRST_STEP = 68
const STEP = 56
const slotX = (slot: number): number => (slot === 0 ? 0 : Math.sign(slot) * (FIRST_STEP + (Math.abs(slot) - 1) * STEP))

/** Places a tile on its slot; moving between slots is what animates. */
const Slot = ({ slot, children }: { slot: number; children: React.ReactNode }): React.JSX.Element => (
  <div
    className="absolute top-8 left-1/2 transition-transform duration-300 ease-out motion-reduce:transition-none"
    style={{ transform: `translate(calc(-50% + ${slotX(slot)}px), -50%)`, zIndex: slot === 0 ? 1 : 0 }}
  >
    {children}
  </div>
)

/** A provider's mark on its own, where there is nothing to choose. */
const Mark = ({ provider }: { provider: AgentProvider }): React.JSX.Element => (
  <span className={cn(TILE, 'size-14')}>
    <ProviderIcon provider={provider} className="size-7" />
  </span>
)

const SIDE = 'size-11 opacity-50 grayscale hover:scale-105 hover:opacity-100 hover:grayscale-0'
const FOCUS = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40'

/** One choice: the picked one large and ringed in the centre, the others small and quiet at the sides. */
function ProviderChoice({ provider, active, onPick }: { provider: AgentProvider; active: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <button type="button" role="radio" aria-checked={active} aria-label={PROVIDER_NAMES[provider]} title={PROVIDER_NAMES[provider]} onClick={onPick} className={cn(TILE, FOCUS, active ? 'size-16 ring-2 ring-foreground/40' : SIDE)}>
      <ProviderIcon provider={provider} className={cn('transition-all duration-300 motion-reduce:transition-none', active ? 'size-8' : 'size-5')} />
    </button>
  )
}

/** Who runs the conversation; while a new session is composed, a choice among the installed providers. */
function ProviderTiles({ agent }: { agent: WorktreeAgent }): React.JSX.Element | null {
  const only = agent.selected?.provider ?? (agent.providers.length < 2 || agent.turn.busy ? (agent.fresh ?? agent.providers[0]) : undefined)
  if (only) return <Mark provider={only} />
  if (agent.providers.length === 0) return null
  const { shown, folded } = splitProviders(agent.providers, agent.fresh)
  const sides = shown.filter((provider) => provider !== agent.fresh)
  const outermost = Math.ceil((sides.length + (folded.length > 0 ? 1 : 0)) / 2)
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Choose your agent</p>
      <div role="radiogroup" aria-label="Agent for the new session" className="relative h-16" style={{ width: 2 * slotX(outermost) + 64 }}>
        {shown.map((provider) => (
          <Slot key={provider} slot={provider === agent.fresh ? 0 : sideSlot(sides.indexOf(provider))}>
            <ProviderChoice provider={provider} active={provider === agent.fresh} onPick={() => agent.startSession(provider)} />
          </Slot>
        ))}
        {folded.length > 0 ? (
          <Slot slot={sideSlot(sides.length)}>
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`${folded.length} more agents`} title="More agents" className={cn(TILE, FOCUS, 'size-11 text-xs text-muted-foreground hover:scale-105 hover:text-foreground')}>
                +{folded.length}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                {folded.map((provider) => (
                  <DropdownMenuItem key={provider} onSelect={() => agent.startSession(provider)}>
                    <ProviderIcon provider={provider} className="size-4" /> {PROVIDER_NAMES[provider]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </Slot>
        ) : null}
      </div>
    </div>
  )
}

/**
 * An empty conversation's welcome: who runs it (a choice, while a new session is composed), what
 * this conversation is, and a line of coding folklore to set the mood.
 */
export function AgentWelcome({ agent, note }: { agent: WorktreeAgent; note: string }): React.JSX.Element {
  const [line] = useState(() => CODING_LINES[Math.floor(Math.random() * CODING_LINES.length)])
  const ready = agent.fresh !== undefined || agent.selected !== undefined
  return (
    <div className="relative isolate flex min-h-[28rem] flex-col items-center justify-center gap-4 overflow-hidden px-6 py-12 text-center">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:18px_18px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      {GLYPHS.map(({ text, at }) => (
        <span key={text} aria-hidden="true" className={cn('pointer-events-none absolute -z-10 font-mono text-sm text-muted-foreground/25 select-none', at)}>
          {text}
        </span>
      ))}
      <ProviderTiles agent={agent} />
      <div className="flex flex-col items-center gap-1.5">
        <p className="text-base font-semibold tracking-tight">{titleOf(agent)}</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{note}</p>
      </div>
      <p className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span aria-hidden="true" className="text-primary">❯</span>
        <span className="truncate">{line}</span>
        <span aria-hidden="true" className="h-3.5 w-1.5 shrink-0 animate-pulse bg-muted-foreground/60" />
      </p>
      {ready ? (
        <p className="flex flex-wrap justify-center gap-3 text-[11px] text-muted-foreground">
          {HINTS.map(({ key, label }) => (
            <span key={key} className="flex items-center gap-1.5">
              <kbd className="rounded border border-border bg-card px-1.5 py-px font-mono text-[10px] text-foreground">{key}</kbd>
              {label}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  )
}
