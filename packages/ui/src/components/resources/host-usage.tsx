import { formatMem, type HostSample } from '@canopy/shared'

import { Meter } from '@/components/ui/meter'
import { memBreakdown, seriesVar } from '@/lib/environment-ui'
import { cn } from '@/lib/utils'

export { SERIES_VARS, niceScale, seriesVar } from '@/lib/environment-ui'

/**
 * One cell per host core with its utilization. Real schedulers move work between cores every
 * few milliseconds, so the grid answers "how loaded is this machine", not "where does my
 * worktree run" — the cells stay neutral and unowned.
 */
export function CoreGrid({ cores, label = 'host' }: { cores: number[]; label?: string }): React.JSX.Element {
  if (cores.length === 0) {
    return <p className="text-[10px] text-muted-foreground">Waiting for the first host sample…</p>
  }
  return (
    <div className="grid grid-cols-4 gap-x-3 gap-y-2">
      {cores.map((pct, core) => (
        <div key={core} className="flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between text-[10px]">
            <span className="text-muted-foreground">c{core}</span>
            <span className="tabular-nums">{Math.round(pct)}%</span>
          </div>
          <Meter fraction={pct / 100} className={pct < 6 ? 'opacity-50' : undefined} />
          <span className="truncate text-[9px] text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  )
}

/** The whole machine's memory as one bar: the named consumers, everything else, free. */
export function SystemMemBar({
  parts,
  host,
  hostMemMb,
  label = 'worktree'
}: {
  parts: Array<{ name: string; memMb?: number }>
  host: HostSample | undefined
  hostMemMb: number
  /** What the colored segments collectively are — "worktree" on a dashboard, "worktrees" fleet-wide. */
  label?: string
}): React.JSX.Element {
  const { segments, usedMb, otherMb, freeMb, totalMb } = memBreakdown(parts, host, hostMemMb)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-sm">
        {segments.map((segment) => (
          <div
            key={segment.key}
            title={`${segment.label} ${formatMem(segment.memMb)}`}
            className={cn(segment.kind === 'other' && 'bg-muted-foreground/45', segment.kind === 'free' && 'bg-border/50')}
            style={{ width: `${segment.fraction * 100}%`, backgroundColor: segment.kind === 'series' ? seriesVar(segment.index) : undefined }}
          />
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground tabular-nums">
        {label} <span className="text-foreground">{formatMem(usedMb)}</span> · other {formatMem(otherMb)} · free {formatMem(freeMb)} — host {formatMem(totalMb)}
      </p>
    </div>
  )
}
