import { useEffect, useLayoutEffect, useRef } from 'react'
import { PanelsTopLeft, Power, RefreshCw, TriangleAlert } from 'lucide-react'

import { formatMem, type OpenTarget, type Project, type ServiceAction, type Worktree } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { Meter } from '@/components/ui/meter'
import { StatusDot } from '@/components/ui/status-dot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { trayGroups, traySummary } from '@/lib/tray-model'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

import { TrayWorktreeRow } from './tray-worktree-row'
import { useTrayAction } from './use-tray-action'

export type TrayConnectionStatus = 'connecting' | 'connected' | 'offline'

export interface TrayPanelProps {
  status: TrayConnectionStatus
  /** Why the daemon is unreachable; null while connected. */
  error: string | null
  projects: Project[]
  worktrees: Worktree[]
  /** What the meters measure Canopy against; null until the daemon has been asked. */
  machine: { cores: number; memMb: number } | null
  /** Actions resolve with the daemon's message on failure and null on success. */
  onLifecycle: (worktreeId: string, action: 'start' | 'stop' | 'restart' | 'provision') => Promise<string | null>
  onService: (worktreeId: string, service: string, action: ServiceAction) => Promise<string | null>
  onOpen: (worktreeId: string, target: OpenTarget) => Promise<string | null>
  /** Stops every running environment across every project. */
  onStopAll: () => Promise<string | null>
  /** Raises the app window, on a hash route when one is given. */
  onOpenApp: (hash?: string) => void
  onOpenExternal: (url: string) => void
  /** Reconnect now instead of waiting out the backoff. */
  onRetry: () => void
  /** Puts the panel away — Escape, the same as clicking outside it. */
  onDismiss: () => void
  onQuit: () => void
  /** The panel's natural height, so the window can hug its content. */
  onHeight: (height: number) => void
  /** What to tell the user to run when canopyd is not up. */
  daemonHint?: string
}

/**
 * One of Canopy's own totals: the exact figure, over a bar for its share of the machine.
 *
 * The denominator is deliberately the whole machine and not an adaptive ceiling. `cpuScale`/
 * `memScale` take their ceiling from the values they are given, which works for a series but is
 * self-referential for a single reading — an idle 120 MB would paint a half-full bar. Against
 * the machine the bar is monotonic: empty when Canopy is costing nothing, full when it owns the
 * box, and "nothing" is the answer you want at a glance.
 */
function MeterStat({ label, value, sub, fraction }: { label: string; value: string; sub: string; fraction: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-[10px] tabular-nums">{value}</span>
      </div>
      <Meter fraction={fraction} />
      <span className="truncate font-mono text-[9px] text-muted-foreground">{sub}</span>
    </div>
  )
}

/** A block that fills the panel when there is nothing to list. */
function TrayNotice({ title, body, action }: { title: string; body: string; action?: React.JSX.Element }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{body}</p>
      {action}
    </div>
  )
}

/**
 * The menu-bar popover: what every project is running, the ports to click into, and the few
 * actions worth taking without opening the app. It renders a snapshot and calls back — the
 * daemon connection lives in the main process, so the icon is right whether or not this window
 * has ever been opened.
 */
export function TrayPanel(props: TrayPanelProps): React.JSX.Element {
  const { status, error, projects, worktrees, machine, onDismiss, onOpenApp, onQuit, onRetry, onStopAll, onHeight, daemonHint } = props
  // Shares the app window's stored choice, so the panel matches whatever theme Canopy is in.
  useTheme()
  const stopAll = useTrayAction()
  const groups = trayGroups(projects, worktrees)
  const summary = traySummary(worktrees)

  const header = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLDivElement>(null)

  /**
   * The window hugs the content, so the height has to be the *natural* one — the scroll
   * container's own height is whatever the window already is. Measuring the three sections
   * separately is what keeps the two from chasing each other.
   */
  useLayoutEffect(() => {
    const parts = [header.current, body.current, footer.current].filter((part): part is HTMLDivElement => part !== null)
    if (parts.length === 0) return
    // +2 for the surface's own top and bottom border, which sits outside all three.
    const report = (): void => onHeight(parts.reduce((total, part) => total + part.offsetHeight, 2))
    const observer = new ResizeObserver(report)
    for (const part of parts) observer.observe(part)
    report()
    return () => observer.disconnect()
  }, [onHeight])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  const offline = status === 'offline'

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen select-none flex-col overflow-hidden rounded-xl border border-border/80 bg-popover/95 text-popover-foreground shadow-2xl">
        <div ref={header} className="shrink-0 border-b border-border/70 px-3 pb-2.5 pt-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold tracking-tight">Canopy</span>
            <span className="ml-auto flex items-center gap-1.5 text-[11px]">
              {offline ? (
                <>
                  <StatusDot status="error" />
                  <span className="text-muted-foreground">canopyd offline</span>
                </>
              ) : status === 'connecting' ? (
                <>
                  <StatusDot status="running" />
                  <span className="text-muted-foreground">connecting…</span>
                </>
              ) : (
                <>
                  <StatusDot status={summary.failing > 0 ? 'error' : summary.running > 0 ? 'success' : 'idle'} />
                  <span className={cn(summary.failing > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {summary.running > 0 ? `${summary.running} running` : 'nothing running'}
                    {summary.failing > 0 ? ` · ${summary.failing} failing` : ''}
                  </span>
                </>
              )}
            </span>
          </div>
          {!offline && summary.processes > 0 ? (
            <div className="mt-2 grid grid-cols-2 gap-3" title={`Canopy across ${summary.processes} supervised process${summary.processes === 1 ? '' : 'es'}`}>
              <MeterStat
                label="cpu"
                value={`${summary.cpuPct}%`}
                sub={machine ? `of ${machine.cores} cores` : 'of this machine'}
                fraction={machine && machine.cores > 0 ? summary.cpuPct / (machine.cores * 100) : 0}
              />
              <MeterStat
                label="mem"
                value={formatMem(summary.memMb)}
                sub={machine ? `of ${formatMem(machine.memMb)}` : 'of this machine'}
                fraction={machine && machine.memMb > 0 ? summary.memMb / machine.memMb : 0}
              />
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div ref={body} className="px-2 py-1.5">
            {offline ? (
              <TrayNotice
                title="canopyd is not running"
                body={error ? `${error}. ${daemonHint ?? ''}`.trim() : (daemonHint ?? 'Start the daemon and the panel reconnects on its own.')}
                action={
                  <Button variant="outline" size="sm" className="mt-1 h-7" onClick={onRetry}>
                    <RefreshCw className="size-3" /> Try again
                  </Button>
                }
              />
            ) : groups.length === 0 ? (
              <TrayNotice
                title={status === 'connecting' ? 'Connecting to canopyd…' : 'Nothing provisioned yet'}
                body={status === 'connecting' ? 'Reading the fleet.' : 'Create a worktree in Canopy and it shows up here with its ports.'}
                action={
                  status === 'connecting' ? undefined : (
                    <Button variant="outline" size="sm" className="mt-1 h-7" onClick={() => onOpenApp()}>
                      <PanelsTopLeft className="size-3" /> Open Canopy
                    </Button>
                  )
                }
              />
            ) : (
              groups.map((group) => (
                <section key={group.project.id} className="mb-1 last:mb-0">
                  <h2 className="px-2 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{group.project.name}</h2>
                  {group.worktrees.map((worktree) => (
                    <TrayWorktreeRow
                      key={worktree.id}
                      worktree={worktree}
                      onLifecycle={props.onLifecycle}
                      onService={props.onService}
                      onOpen={props.onOpen}
                      onOpenApp={onOpenApp}
                      onOpenExternal={props.onOpenExternal}
                    />
                  ))}
                </section>
              ))
            )}
          </div>
        </div>

        <div ref={footer} className="shrink-0 border-t border-border/70 px-2 py-1.5">
          {stopAll.error ? (
            <p className="flex items-center gap-1 px-1 pb-1 text-[10px] text-destructive" role="alert">
              <TriangleAlert className="size-3 shrink-0" />
              {stopAll.error}
            </p>
          ) : null}
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onOpenApp()}>
              <PanelsTopLeft className="size-3" /> Open Canopy
            </Button>
            {summary.running > 0 ? (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={stopAll.pending !== null} onClick={() => stopAll.run('stop-all', onStopAll)}>
                <Power className="size-3" /> Stop all
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-[11px] text-muted-foreground" onClick={onQuit}>
              Quit
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
