import { useEffect } from 'react'

import type { ContextUsage } from '@canopy/shared/agent-stream'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { readStored, writeStored } from '@/lib/local-store'
import { cn } from '@/lib/utils'

/** `31437` → `31.4k`, `1000000` → `1M`: the scale a person compares windows at. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number.isInteger(tokens / 1_000_000) ? tokens / 1_000_000 : (tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

/** The one-line account the tooltip and the accessible label share. */
export function describeContext(usage: ContextUsage, window: number | null): string {
  if (usage.tokens === null) return window === null ? 'Context size not reported yet' : `Context window ${formatTokens(window)}`
  if (window === null) return `${formatTokens(usage.tokens)} tokens in context`
  return `${formatTokens(usage.tokens)} of ${formatTokens(window)} context used · ${Math.round((usage.tokens / window) * 100)}%`
}

const WINDOWS_KEY = 'canopy-context-windows'

/**
 * What a model's window is when the wire has not said yet. The Claude 5 family runs on a 1M
 * window — the checked-in `tools.jsonl` capture states it for Sonnet 5, and a Fable session has
 * been seen holding 583k — Haiku 4.5 on 200k, and a `[1m]` suffix says so outright. Anything
 * the wire or a remembered result states wins over this; unknown models get no fraction.
 */
export function assumedContextWindow(model: string | undefined): number | null {
  if (!model) return null
  const id = model.toLowerCase()
  if (id.includes('[1m]')) return 1_000_000
  if (/fable|opus|sonnet/.test(id)) return 1_000_000
  if (/haiku/.test(id)) return 200_000
  return null
}

/**
 * The window to measure against. The wire states it only on a turn's result, so a replayed
 * session knows its prompt sizes but not its window until it has run a turn — and a page reload
 * would forget it again. Once a result names the window for a model it is remembered per model,
 * which is the one fact here that does not change between sessions. Failing both, the model's
 * family says what to assume.
 */
export function useContextWindow(usage: ContextUsage | null, model: string | undefined): number | null {
  const stated = usage?.window ?? null
  useEffect(() => {
    if (stated === null || !model) return
    const known = readStored<Record<string, number>>(WINDOWS_KEY) ?? {}
    if (known[model] !== stated) writeStored(WINDOWS_KEY, { ...known, [model]: stated })
  }, [stated, model])
  if (stated !== null) return stated
  const remembered = model ? (readStored<Record<string, number>>(WINDOWS_KEY)?.[model] ?? null) : null
  return remembered ?? assumedContextWindow(model)
}

/**
 * The wedge is a stroke as wide as its radius on a circle half the size of the disc: dashing that
 * stroke fills the disc from the centre out, which is how a `<circle>` draws a pie without a path
 * per fraction. The outline is a separate, thinner ring so the wedge reads against an empty disc.
 */
const DISC = 7
const WEDGE = DISC / 2
const WEDGE_LENGTH = 2 * Math.PI * WEDGE
const RIM_LENGTH = 2 * Math.PI * DISC

/**
 * How full the agent's context window is, as a small ring in the composer footer — the glance
 * that says whether to keep going, start fresh, or expect Claude Code to compact soon. The disc
 * fills clockwise with the share used, traced round the rim as well — in the chat accent while
 * there is room, amber from 70%, red from 85%. Without a known window it shows the token count alone and an empty disc, rather than a
 * fraction of a guess.
 */
export function ContextMeter({ usage, model, className }: { usage: ContextUsage | null; model?: string; className?: string }): React.JSX.Element | null {
  const window = useContextWindow(usage, model)
  if (!usage) return null
  const fraction = usage.tokens !== null && window !== null ? Math.min(1, usage.tokens / window) : 0
  const level = fraction >= 0.85 ? 'high' : fraction >= 0.7 ? 'warm' : 'ok'
  const label = describeContext(usage, window)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="context-meter"
          data-level={level}
          role="meter"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuetext={label}
          tabIndex={0}
          className={cn(
            'inline-flex h-8 cursor-default items-center gap-1.5 rounded-md px-1.5 text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
            level === 'warm' && 'text-amber-600 dark:text-amber-500',
            level === 'high' && 'text-destructive',
            className
          )}
        >
          <svg
            viewBox="0 0 16 16"
            className={cn('size-4 shrink-0 -rotate-90', level === 'ok' && 'text-(--nessa-chat-accent)')}
            aria-hidden="true"
          >
            {/* The track: an empty disc in the label's grey, whatever colour the fill takes. */}
            <circle cx="8" cy="8" r={DISC} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground opacity-35" />
            {/* The share used, filled from the centre and traced round the rim in the accent. */}
            <circle
              cx="8"
              cy="8"
              r={WEDGE}
              fill="none"
              stroke="currentColor"
              strokeWidth={DISC}
              strokeDasharray={WEDGE_LENGTH}
              strokeDashoffset={WEDGE_LENGTH * (1 - fraction)}
              className="opacity-30 transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
            />
            <circle
              cx="8"
              cy="8"
              r={DISC}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray={RIM_LENGTH}
              strokeDashoffset={RIM_LENGTH * (1 - fraction)}
              className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
            />
          </svg>
          {usage.tokens !== null ? <span className="nessa-text-2 tabular-nums">{window !== null ? `${Math.round(fraction * 100)}%` : formatTokens(usage.tokens)}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
        <p className="text-muted-foreground">Claude Code compacts on its own as the window fills.</p>
      </TooltipContent>
    </Tooltip>
  )
}
