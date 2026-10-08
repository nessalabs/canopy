import { useEffect, useRef } from 'react'

import { SERVICE_DOT, formatMem, serviceResources, type Runtime, type ServiceInfo, type Worktree } from '@canopy/shared'

import { FramedBox } from '@/components/ui/framed-box'
import { Meter, type MeterSlot } from '@/components/ui/meter'
import { StatusDot } from '@/components/ui/status-dot'
import { useHost, useResourcesBackfill } from '@/lib/api-hooks'
import { cpuScale, memScale, seriesVar, shortId, sparkline, uptime } from '@/lib/environment-ui'
import { useHostSamples, useResourceSamples, useSampleStore } from '@/lib/events-provider'

import { CoreGrid, SystemMemBar } from './host-usage'

/** Services with a process behind them right now — the only ones that can report usage. */
const RUNNING: ServiceInfo['status'][] = ['starting', 'healthy', 'unhealthy', 'restarting', 'stopping']

const RUNTIME_LABEL: Record<Runtime, string> = { host: 'host', docker: 'dckr', compose: 'cmps' }

const slotOf = (index: number): MeterSlot => ((index % 6) + 1) as MeterSlot

/** A bar per sample, height by value — a plain-div history strip, no chart library. */
function Sparkline({ values, floor, format, index }: { values: number[]; floor: number; format: (value: number) => string; index: number }): React.JSX.Element {
  const { scale, heights } = sparkline(values, floor)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-10 w-full items-end gap-px" role="img" aria-label={`${values.length} samples, peak ${format(Math.max(0, ...values))}`}>
        {heights.map((height, position) => (
          <div
            key={position}
            className="min-w-px flex-1 rounded-t-[1px]"
            style={{ height: `${height}%`, backgroundColor: seriesVar(index) }}
            title={format(values[position])}
          />
        ))}
      </div>
      <div className="flex items-baseline justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>now {format(values.at(-1) ?? 0)}</span>
        <span>scale {format(scale)}</span>
      </div>
    </div>
  )
}

/**
 * btop for one worktree: total and per-service CPU and memory against the real host, the
 * process table behind them, and a short history of both. Live samples arrive over the event
 * stream; the REST backfill seeds the store once so the history is not empty on open.
 */
export function ResourcesTab({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const samples = useResourceSamples(worktree.id)
  const hostSamples = useHostSamples()
  const store = useSampleStore()
  const host = useHost().data
  const backfill = useResourcesBackfill(worktree.id)
  const seeded = useRef<string>(undefined)

  useEffect(() => {
    if (!backfill.data || seeded.current === worktree.id) return
    seeded.current = worktree.id
    store.seed(worktree.id, backfill.data.samples, backfill.data.host)
  }, [backfill.data, store, worktree.id])

  const env = worktree.environment
  const active = env.services.filter((service) => !service.excluded)
  const running = active.filter((service) => RUNNING.includes(service.status))
  const totals = serviceResources(env.services)
  const latestHost = hostSamples.at(-1)
  const cores = host?.cores ?? latestHost?.cores.length ?? 0
  const hostMemMb = host?.memMb ?? latestHost?.memTotalMb ?? 0
  const up = uptime(env.startedAt)
  const cpuTop = cpuScale([totals.cpuPct, ...active.map((service) => service.cpuPct ?? 0)], cores)
  const memTop = memScale([totals.memMb, ...active.map((service) => service.memMb ?? 0)])

  if (running.length === 0) {
    return (
      <div className="@container flex flex-col gap-4 font-mono">
        <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">Start the worktree and its usage lands here.</p>
        <div className="grid gap-4 @3xl:grid-cols-2">
          <FramedBox title="cpu" annotation={`${cores} cores · host`} className="bg-card">
            <div className="px-3 pt-1 pb-3">
              <CoreGrid cores={latestHost?.cores ?? []} />
            </div>
          </FramedBox>
          <FramedBox title="mem" annotation={hostMemMb > 0 ? `host ${formatMem(hostMemMb)}` : 'host'} className="bg-card">
            <div className="px-3 pt-1 pb-3">
              <SystemMemBar parts={[]} host={latestHost} hostMemMb={hostMemMb} />
            </div>
          </FramedBox>
        </div>
      </div>
    )
  }

  return (
    <div className="@container flex flex-col gap-4 font-mono">
      <div className="grid gap-4 @3xl:grid-cols-5">
        <div className="flex flex-col gap-4 @3xl:col-span-2">
          <FramedBox title="cpu" annotation={`${cores} cores${up ? ` · up ${up}` : ''}`} className="bg-card">
            <div className="flex flex-col gap-1.5 px-3 pt-1 pb-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="w-14 shrink-0 truncate font-medium">CPU</span>
                <Meter fraction={totals.cpuPct / cpuTop} className="flex-1" />
                <span className="w-12 shrink-0 text-right tabular-nums">{totals.cpuPct}%</span>
              </div>
              {active.map((service, index) => (
                <div key={service.name} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="w-14 shrink-0 truncate" title={service.name}>
                    {service.name}
                  </span>
                  <Meter fraction={(service.cpuPct ?? 0) / cpuTop} slot={slotOf(index)} className="flex-1" />
                  <span className="w-12 shrink-0 text-right tabular-nums">{service.cpuPct !== undefined ? `${service.cpuPct}%` : '—'}</span>
                </div>
              ))}
              <div className="mt-1.5 border-t border-border/60 pt-2">
                <CoreGrid cores={latestHost?.cores ?? []} />
              </div>
            </div>
          </FramedBox>
          <FramedBox title="mem" annotation={`${formatMem(totals.memMb)}${hostMemMb > 0 ? ` of ${formatMem(hostMemMb)}` : ''}`} className="bg-card">
            <div className="flex flex-col gap-1.5 px-3 pt-1 pb-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="w-14 shrink-0 truncate font-medium">Used</span>
                <Meter fraction={totals.memMb / memTop} className="flex-1" />
                <span className="w-16 shrink-0 text-right tabular-nums">{formatMem(totals.memMb)}</span>
              </div>
              {active.map((service, index) => (
                <div key={service.name} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="w-14 shrink-0 truncate" title={service.name}>
                    {service.name}
                  </span>
                  <Meter fraction={(service.memMb ?? 0) / memTop} slot={slotOf(index)} className="flex-1" />
                  <span className="w-16 shrink-0 text-right tabular-nums">{service.memMb !== undefined ? formatMem(service.memMb) : '—'}</span>
                </div>
              ))}
              <div className="mt-1.5 border-t border-border/60 pt-2">
                <SystemMemBar parts={active} host={latestHost} hostMemMb={hostMemMb} />
              </div>
            </div>
          </FramedBox>
        </div>
        <FramedBox title="proc" annotation={`${running.length} of ${active.length} services`} className="bg-card @3xl:col-span-3">
          <div className="overflow-x-auto px-3 pt-1 pb-3">
            <div className="grid min-w-xl grid-cols-[5.5rem_5rem_1fr_3.5rem_6rem_5.5rem] gap-x-3 text-[11px]">
              <span className="text-muted-foreground">Pid:</span>
              <span className="text-muted-foreground">Program:</span>
              <span className="text-muted-foreground">Command:</span>
              <span className="text-muted-foreground">Run:</span>
              <span className="text-right text-muted-foreground">MemB</span>
              <span className="text-right text-muted-foreground">Cpu%</span>
              {running.map((service, index) => (
                <div key={service.name} className="col-span-6 grid grid-cols-subgrid items-center py-0.5">
                  <span className="truncate tabular-nums">{service.containerId ? shortId(service.containerId) : (service.pid ?? '—')}</span>
                  <span className="flex items-center gap-1.5 truncate">
                    <StatusDot status={SERVICE_DOT[service.status]} />
                    {service.name}
                  </span>
                  <span className="truncate text-muted-foreground" title={service.command}>
                    {service.command}
                  </span>
                  <span className="text-muted-foreground">{RUNTIME_LABEL[service.runtime]}</span>
                  <span className="flex items-center justify-end gap-1.5 tabular-nums">
                    <Meter fraction={(service.memMb ?? 0) / memTop} slot={slotOf(index)} className="max-w-8 flex-1" />
                    {service.memMb !== undefined ? formatMem(service.memMb) : '—'}
                  </span>
                  <span className="flex items-center justify-end gap-1.5 tabular-nums">
                    <Meter fraction={(service.cpuPct ?? 0) / cpuTop} slot={slotOf(index)} className="max-w-8 flex-1" />
                    {service.cpuPct !== undefined ? `${service.cpuPct}%` : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </FramedBox>
      </div>
      <FramedBox title="history" annotation={`${samples.length} samples`} className="bg-card">
        <div className="grid gap-4 px-3 pt-2 pb-3 @md:grid-cols-2">
          {samples.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Waiting for the first sample…</p>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground">cpu %</span>
                <Sparkline values={samples.map((sample) => sample.totalCpuPct)} floor={20} format={(value) => `${Math.round(value)}%`} index={0} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground">memory</span>
                <Sparkline values={samples.map((sample) => sample.totalMemMb)} floor={64} format={formatMem} index={1} />
              </div>
            </>
          )}
        </div>
      </FramedBox>
    </div>
  )
}
