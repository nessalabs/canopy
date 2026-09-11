import { useState } from 'react'
import { Check, ChevronRight, Cpu, Database, Puzzle, Webhook } from 'lucide-react'

import type { AgentCapabilities } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTokenCount, type AnswerTable, type ContextReport, type McpSummary, type ModelReport, type SkillDoctorReport } from '@/lib/local-answers'
import { cn } from '@/lib/utils'

// ---- /context ----

/** Six fixed series colours, in the CLI's category order; whatever comes after the sixth folds into "Other". */
const SLOT_VARS = ['--nessa-chart-1', '--nessa-chart-2', '--nessa-chart-3', '--nessa-chart-4', '--nessa-chart-5', '--nessa-chart-6'] as const

interface Segment {
  name: string
  tokens: number
  percent: number
  color: string
  /** The autocompact reserve: shown, but not "used". */
  reserve?: boolean
}

function segmentsOf(report: ContextReport): Segment[] {
  const named = report.categories.slice(0, SLOT_VARS.length).map((category, index) => ({ ...category, color: `var(${SLOT_VARS[index]})` }))
  const rest = report.categories.slice(SLOT_VARS.length)
  const other = rest.length > 0 ? [{ name: 'Other', tokens: rest.reduce((sum, c) => sum + c.tokens, 0), percent: rest.reduce((sum, c) => sum + c.percent, 0), color: 'var(--muted-foreground)' }] : []
  const reserve = report.buffer ? [{ ...report.buffer, color: 'var(--border)', reserve: true }] : []
  return [...named, ...other, ...reserve]
}

/** One bar for the whole window: each occupant a segment with a 2px gap, free space the recessive track. */
function ContextBar({ segments }: { segments: Segment[] }): React.JSX.Element {
  // Segments under a third of a percent would vanish; give each a visible minimum and let the track absorb it.
  const widths = segments.map((segment) => Math.max(segment.percent, segment.tokens > 0 ? 0.4 : 0))
  return (
    <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label="Context window by category">
      {segments.map((segment, index) => (
        <span
          key={segment.name}
          className={cn('h-full shrink-0 rounded-sm', segment.reserve && 'bg-[repeating-linear-gradient(135deg,transparent_0_2px,var(--muted-foreground)_2px_3px)] opacity-60')}
          style={{ width: `${widths[index]}%`, ...(segment.reserve ? {} : { background: segment.color }) }}
          title={`${segment.name}: ${formatTokenCount(segment.tokens)} tokens (${segment.percent}%)`}
        />
      ))}
    </div>
  )
}

function DetailTable({ table }: { table: AnswerTable }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const tokenColumn = table.columns.findIndex((column) => /tokens/i.test(column))
  const total = tokenColumn === -1 ? null : table.rows.reduce((sum, row) => sum + (Number((row[tokenColumn] ?? '').replace(/[^\d.]/g, '')) || 0), 0)
  return (
    <div className="border-t border-border/60">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-2 text-left nessa-text-2 text-foreground hover:text-foreground/80"
      >
        <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="font-medium">{table.title}</span>
        <span className="font-mono tabular-nums text-muted-foreground">
          · {table.rows.length}
          {total !== null ? ` · ${formatTokenCount(Math.round(total))} tokens` : ''}
        </span>
      </button>
      {open ? (
        <div className="overflow-x-auto pb-2">
          <table className="w-full border-collapse nessa-text-2">
            <thead>
              <tr>
                {table.columns.map((column, index) => (
                  <th key={column} className={cn('py-1 pr-3 text-left nessa-text-1 font-normal uppercase tracking-wide text-muted-foreground', index === tokenColumn && 'text-right')}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-border/40">
                  {row.map((cell, index) => (
                    <td key={index} className={cn('max-w-72 truncate py-1 pr-3 font-mono text-foreground', index === tokenColumn && 'text-right tabular-nums text-muted-foreground')} title={cell}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

/**
 * `/context` as the split it describes: the window as one bar, each occupant a segment and free
 * space the track, a legend with the numbers, and the detail tables folded away by title.
 */
export function ContextCard({ report }: { report: ContextReport }): React.JSX.Element {
  const segments = segmentsOf(report)
  return (
    <div className="@container flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-center gap-2 nessa-text-3 font-medium text-foreground">
          <Database className="size-4 text-muted-foreground" aria-hidden="true" />
          Context window
          {report.model ? <span className="font-mono nessa-text-1 font-normal text-muted-foreground">{report.model}</span> : null}
        </span>
        <span className="font-mono nessa-text-3 tabular-nums text-foreground">
          {formatTokenCount(report.used)} <span className="text-muted-foreground">/ {formatTokenCount(report.limit)} · {report.percent}%</span>
        </span>
      </div>
      <ContextBar segments={segments} />
      <ul className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-1 p-0 @md:grid-cols-2">
        {segments.map((segment) => (
          <li key={segment.name} className="flex min-w-0 items-center gap-2 nessa-text-2">
            <span
              className={cn('size-2.5 shrink-0 rounded-sm', segment.reserve && 'bg-[repeating-linear-gradient(135deg,transparent_0_2px,var(--muted-foreground)_2px_3px)] opacity-60')}
              style={segment.reserve ? undefined : { background: segment.color }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{segment.name}</span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {formatTokenCount(segment.tokens)} · {segment.percent}%
            </span>
          </li>
        ))}
        {report.free ? (
          <li className="flex min-w-0 items-center gap-2 nessa-text-2">
            <span className="size-2.5 shrink-0 rounded-sm bg-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">Free</span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {formatTokenCount(report.free.tokens)} · {report.free.percent}%
            </span>
          </li>
        ) : null}
      </ul>
      {report.details.length > 0 ? (
        <div className="flex flex-col">
          {report.details.map((table) => (
            <DetailTable key={table.title} table={table} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---- /skill-doctor ----

export function SkillDoctorCard({ report }: { report: SkillDoctorReport }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="flex items-center gap-2 nessa-text-3 font-medium text-foreground">
        <Puzzle className="size-4 text-muted-foreground" aria-hidden="true" />
        {report.title}
        <span className="font-mono nessa-text-1 font-normal text-muted-foreground">{report.skills.length}</span>
      </span>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse nessa-text-2">
          <thead>
            <tr className="nessa-text-1 uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-3 text-left font-normal">Skill</th>
              <th className="py-1 pr-3 text-left font-normal">Source</th>
              <th className="py-1 pr-3 text-right font-normal">Context</th>
              <th className="py-1 pr-3 text-right font-normal">7d tokens</th>
              <th className="py-1 pr-3 text-right font-normal">Uses</th>
              <th className="py-1 text-right font-normal">Last used</th>
            </tr>
          </thead>
          <tbody>
            {report.skills.map((skill) => {
              const unused = skill.uses === 0
              return (
                <tr key={skill.skill} className={cn('border-t border-border/40', unused && 'text-muted-foreground')}>
                  <td className="max-w-64 truncate py-1 pr-3 font-mono text-foreground" title={skill.skill}>
                    {skill.skill}
                  </td>
                  <td className="py-1 pr-3 text-muted-foreground">{skill.source}</td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums text-muted-foreground">{skill.context}</td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">{skill.tokens7d === null ? '–' : formatTokenCount(skill.tokens7d)}</td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">{skill.uses}</td>
                  <td className="py-1 text-right tabular-nums">{skill.lastUsed}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---- /model ----

/** Whether an alias names the current model: "haiku" ↔ "Haiku 4.5". */
const isCurrent = (alias: string, current: string): boolean => current.toLowerCase().startsWith(alias.replace(/\[.*$/, '').toLowerCase())

/**
 * `/model` as the choice it is: the current model and effort, and every alias the CLI accepts as a
 * chip. Picking one sets the composer's model for the next turn — the same thing typing
 * `/model <alias>` would do, without another turn.
 */
export function ModelCard({ report, onPick }: { report: ModelReport; onPick?: (alias: string) => void }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 nessa-text-3 font-medium text-foreground">
          <Cpu className="size-4 text-muted-foreground" aria-hidden="true" />
          {report.current}
        </span>
        {report.effort ? (
          <Badge variant="outline" className="font-mono nessa-text-1">
            effort {report.effort}
          </Badge>
        ) : null}
      </div>
      {report.available.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="nessa-text-1 uppercase tracking-wide text-muted-foreground">{onPick ? 'Switch to' : 'Available'}</span>
          <div className="flex flex-wrap gap-1.5">
            {report.available.map((alias) => {
              const active = isCurrent(alias, report.current)
              return (
                <Tooltip key={alias}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      disabled={!onPick || active}
                      onClick={() => onPick?.(alias)}
                      aria-pressed={active}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono nessa-text-2 transition-colors',
                        active ? 'border-foreground/30 bg-foreground/10 text-foreground' : 'border-border bg-background/60 text-foreground hover:bg-accent disabled:hover:bg-background/60'
                      )}
                    >
                      {active ? <Check className="size-3" aria-hidden="true" /> : null}
                      {alias}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{active ? 'The current model' : onPick ? `Use ${alias} for the next turn` : alias}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---- /mcp ----

function dotFor(status: string): 'success' | 'error' | 'running' | 'idle' {
  const normalized = status.toLowerCase()
  if (normalized === 'connected') return 'success'
  if (normalized === 'failed' || normalized.includes('auth')) return 'error'
  if (normalized === 'connecting' || normalized === 'pending') return 'running'
  return 'idle'
}

/**
 * `/mcp` prints only counts and points at the terminal for the rest; the daemon already knows
 * every server's status, so the card lists them with the counts as the headline.
 */
export function McpCard({ summary, servers }: { summary: McpSummary; servers?: AgentCapabilities['mcpServers'] }): React.JSX.Element {
  const known = servers ?? []
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="flex items-center gap-2 nessa-text-3 font-medium text-foreground">
        <Webhook className="size-4 text-muted-foreground" aria-hidden="true" />
        MCP servers
        <span className="font-mono nessa-text-1 font-normal text-muted-foreground">
          {summary.connected} connected · {summary.notConnected} not connected{summary.disabled > 0 ? ` · ${summary.disabled} disabled` : ''}
        </span>
      </span>
      {known.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {known.map((server) => (
            <li key={server.name} className="flex min-w-0 items-center justify-between gap-3 border-t border-border/40 py-1.5 first:border-t-0">
              <span className="min-w-0 truncate font-mono nessa-text-2 text-foreground">{server.name}</span>
              <span className="flex shrink-0 items-center gap-1.5 nessa-text-2 text-muted-foreground">
                <StatusDot status={dotFor(server.status)} />
                {server.status}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 nessa-text-2 text-muted-foreground">Server names arrive with the next turn's session details.</p>
      )}
    </div>
  )
}
