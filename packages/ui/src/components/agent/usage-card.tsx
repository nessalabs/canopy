import type { CSSProperties } from 'react'
import { AlertTriangle, Gauge, Puzzle, Users, Webhook } from 'lucide-react'

import { Meter } from '@/components/ui/meter'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatCount, usageSeverity, type UsagePeriod, type UsageReport, type UsageSeverity, type UsageShare, type UsageWindow } from '@/lib/usage-report'
import { cn } from '@/lib/utils'

/**
 * The fill carries how close the window is to its limit: accent while there is room, amber from
 * 70%, the destructive red from 90% — and past 70% the number gets a word and an icon beside it,
 * so the state never rides on colour alone.
 */
const FILL: Record<UsageSeverity, string> = {
  ok: 'var(--nessa-chart-1)',
  warn: 'var(--color-amber-500)',
  critical: 'var(--destructive)'
}

const SEVERITY_WORD: Record<UsageSeverity, string | null> = { ok: null, warn: 'Near limit', critical: 'Almost out' }

/** "Current week (all models)" → "Week · all models": the same fact in fewer characters. */
function windowTitle(label: string): string {
  const match = /^Current (session|week)(?: \((.+)\))?$/i.exec(label)
  if (!match) return label
  const period = match[1] === 'session' ? 'Session' : 'Week'
  return match[2] ? `${period} · ${match[2]}` : period
}

function WindowRow({ window }: { window: UsageWindow }): React.JSX.Element {
  const severity = usageSeverity(window.percent)
  const word = SEVERITY_WORD[severity]
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate nessa-text-3 text-foreground">{windowTitle(window.label)}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          {word ? (
            <span className={cn('flex items-center gap-1 nessa-text-1', severity === 'critical' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500')}>
              <AlertTriangle className="size-3" aria-hidden="true" />
              {word}
            </span>
          ) : null}
          <span className="font-mono nessa-text-4 tabular-nums text-foreground">{window.percent}%</span>
        </span>
      </div>
      <Meter
        fraction={window.percent / 100}
        variant="solid"
        aria-label={`${window.label}: ${window.percent}% used`}
        className="w-full"
        style={{ '--nessa-meter-fill': FILL[severity] } as CSSProperties}
      />
      {window.resetsAt ? (
        <span className="truncate nessa-text-1 text-muted-foreground" title={window.zone ? `${window.resetsAt} (${window.zone})` : undefined}>
          resets {window.resetsAt}
        </span>
      ) : null}
    </div>
  )
}

/** A ranked list as a two-column table: the name in mono, its share right-aligned so the column reads at a glance. */
function Ranking({ icon, label, shares, className }: { icon: React.ReactNode; label: string; shares: UsageShare[]; className?: string }): React.JSX.Element | null {
  if (shares.length === 0) return null
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex items-center gap-1.5 nessa-text-1 uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3" aria-hidden="true">
          {icon}
        </span>
        {label}
      </div>
      <ol className="m-0 grid list-none grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 p-0">
        {shares.map((share) => (
          <li key={share.name} className="contents">
            <span className="min-w-0 truncate font-mono nessa-text-2 text-foreground" title={share.name}>
              {share.name}
            </span>
            <span className="text-right font-mono nessa-text-2 tabular-nums text-muted-foreground">{share.percent}%</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function PeriodCard({ period }: { period: UsagePeriod }): React.JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background/50 p-3" aria-label={period.label}>
      <div className="flex flex-col gap-0.5">
        <span className="nessa-text-3 font-medium text-foreground">{period.label}</span>
        <span className="font-mono nessa-text-1 tabular-nums text-muted-foreground">
          {formatCount(period.requests)} requests · {formatCount(period.sessions)} sessions
        </span>
      </div>
      {period.behaviors.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {period.behaviors.map((behavior) => (
            <li key={behavior.what} className="flex items-center gap-2.5">
              <Meter fraction={behavior.percent / 100} variant="solid" aria-hidden="true" className="w-14 shrink-0" />
              <span className="w-9 shrink-0 font-mono nessa-text-2 tabular-nums text-foreground">{behavior.percent}%</span>
              <span className="min-w-0 nessa-text-2 text-muted-foreground">{behavior.what}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 @md:grid-cols-2">
        <Ranking icon={<Puzzle />} label="Skills" shares={period.skills} />
        <Ranking icon={<Users />} label="Subagents" shares={period.subagents} />
        {/* Server names are long (`plugin:playwright:playwright`), so this list gets the whole row. */}
        <Ranking icon={<Webhook />} label="MCP servers" shares={period.mcpServers} className="@md:col-span-2" />
      </div>
    </section>
  )
}

/**
 * The `/usage` answer as the meters and lists it is: one meter per rate-limit window, then each
 * period's behaviour shares and rankings. Laid out by the width the bubble actually gets — one
 * column in a narrow conversation pane, windows and periods side by side in a wide one — and the
 * CLI's caveat stays, in fine print, because the "contributing" figures are estimates from this
 * machine only.
 */
export function UsageCard({ report, className }: { report: UsageReport; className?: string }): React.JSX.Element {
  return (
    <div className={cn('@container flex min-w-0 flex-col gap-4', className)}>
      <div className="flex items-center gap-2">
        <Gauge className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="nessa-text-3 font-medium text-foreground">Usage</span>
        {report.plan ? <span className="min-w-0 truncate nessa-text-1 text-muted-foreground">{report.plan.replace(/^You are currently using your /i, '').replace(/ to power your Claude Code usage$/i, '')}</span> : null}
      </div>
      <div className={cn('grid gap-x-6 gap-y-4', report.windows.length > 1 && '@lg:grid-cols-3')}>
        {report.windows.map((window) => (
          <WindowRow key={window.label} window={window} />
        ))}
      </div>
      {report.periods.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3">
          <div className="flex items-baseline gap-2">
            <span className="nessa-text-3 font-medium text-foreground">What's contributing</span>
            {report.note ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help nessa-text-1 text-muted-foreground underline decoration-dotted underline-offset-2">approximate</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-72">{report.note}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <div className={cn('grid gap-3', report.periods.length > 1 && '@2xl:grid-cols-2')}>
            {report.periods.map((period) => (
              <PeriodCard key={period.label} period={period} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
