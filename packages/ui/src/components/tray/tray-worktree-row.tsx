import { Code, ExternalLink, Play, RotateCw, Square, Terminal } from 'lucide-react'

import { ENV_STATE_LABEL, environmentDot, formatMem, isLive, type OpenTarget, type ServiceAction, type Worktree } from '@canopy/shared'

import { MergedMark } from '@/components/merged-mark'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { uptime } from '@/lib/environment-ui'
import { isFailing, portUrl, trayPorts } from '@/lib/tray-model'
import { cn } from '@/lib/utils'

import { useTrayAction } from './use-tray-action'

/** Lifecycle commands already in flight; every button waits them out. */
const BUSY_STATES = ['creating', 'provisioning', 'starting', 'stopping', 'destroying']

export interface TrayWorktreeRowProps {
  worktree: Worktree
  onLifecycle: (worktreeId: string, action: 'start' | 'stop' | 'restart' | 'provision') => Promise<string | null>
  onService: (worktreeId: string, service: string, action: ServiceAction) => Promise<string | null>
  onOpen: (worktreeId: string, target: OpenTarget) => Promise<string | null>
  onOpenApp: (hash: string) => void
  onOpenExternal: (url: string) => void
}

/** A port a service is listening on, as something to click. */
function PortChip({ label, port, primary, onOpen }: { label: string; port: number; primary: boolean; onOpen: (url: string) => void }): React.JSX.Element {
  const url = portUrl(port)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onOpen(url)}
          className={cn(
            'flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-none transition-colors',
            primary ? 'border-border bg-accent/60 text-foreground hover:bg-accent' : 'border-border/70 text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          )}
        >
          <span className="max-w-16 truncate">{label}</span>
          <span className="tabular-nums opacity-70">:{port}</span>
          <ExternalLink className="size-2.5 opacity-60" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Open {url}</TooltipContent>
    </Tooltip>
  )
}

function IconAction({ label, icon, onClick, disabled }: { label: string; icon: React.JSX.Element; onClick: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6 rounded-md" aria-label={label} disabled={disabled} onClick={onClick}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * One worktree: its state, the ports you can click into, what it is costing, and the lifecycle
 * buttons. The name opens the worktree in the app window — the panel deliberately stops short
 * of anything destructive, which belongs on a screen with room to confirm it.
 */
export function TrayWorktreeRow({ worktree, onLifecycle, onService, onOpen, onOpenApp, onOpenExternal }: TrayWorktreeRowProps): React.JSX.Element {
  const env = worktree.environment
  const action = useTrayAction()
  const live = isLive(env.state)
  const transitioning = BUSY_STATES.includes(env.state) || action.pending !== null
  const ports = trayPorts(worktree)
  const services = env.services.filter((service) => !service.excluded)
  const running = services.filter((service) => ['healthy', 'starting', 'restarting', 'unhealthy'].includes(service.status)).length
  const cpu = services.reduce((total, service) => total + (service.cpuPct ?? 0), 0)
  const memMb = services.reduce((total, service) => total + (service.memMb ?? 0), 0)
  const failing = isFailing(worktree)
  const since = live ? uptime(env.startedAt) : null
  const broken = brokenService(worktree)
  // The daemon's reason is worth surfacing only when it explains a failure; transitions set it too.
  const note = action.error ?? (failing ? env.stateReason : null)

  const lifecycle = (label: string, kind: 'start' | 'stop' | 'restart' | 'provision'): void => action.run(label, () => onLifecycle(worktree.id, kind))

  return (
    <div className="rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/40">
      <div className="flex items-center gap-2">
        <StatusDot status={environmentDot(env)} />
        <button
          type="button"
          onClick={() => onOpenApp(`#/worktrees/${worktree.id}`)}
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium underline-offset-2 hover:underline"
          title={`${worktree.name} — open in Canopy`}
        >
          {worktree.name}
        </button>
        <MergedMark worktree={worktree} side="bottom" />
        <span className={cn('shrink-0 font-mono text-[10px] tabular-nums', failing ? 'text-destructive' : 'text-muted-foreground')}>
          {transitioning ? `${ENV_STATE_LABEL[env.state].toLowerCase()}…` : since ? `up ${since}` : ENV_STATE_LABEL[env.state].toLowerCase()}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {live ? (
            <>
              <IconAction label="Stop" icon={<Square className="size-3" />} disabled={transitioning} onClick={() => lifecycle('stop', 'stop')} />
              <IconAction label="Restart" icon={<RotateCw className={cn('size-3', action.pending === 'restart' && 'animate-spin')} />} disabled={transitioning} onClick={() => lifecycle('restart', 'restart')} />
            </>
          ) : (
            <IconAction
              label="Start"
              icon={<Play className={cn('size-3', action.pending === 'start' && 'animate-pulse')} />}
              disabled={transitioning || !env.configured}
              onClick={() => lifecycle('start', env.state === 'none' ? 'provision' : 'start')}
            />
          )}
          <IconAction label="Open in editor" icon={<Code className="size-3" />} disabled={action.pending !== null} onClick={() => action.run('editor', () => onOpen(worktree.id, 'editor'))} />
          <IconAction label="Open in terminal" icon={<Terminal className="size-3" />} disabled={action.pending !== null} onClick={() => action.run('terminal', () => onOpen(worktree.id, 'terminal'))} />
        </span>
      </div>

      {ports.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-4">
          {ports.map((port) => (
            <PortChip key={`${port.service}/${port.name}`} label={port.name} port={port.port} primary={port.primary} onOpen={onOpenExternal} />
          ))}
        </div>
      ) : null}

      {note ? (
        <p className="mt-1 pl-4 text-[10px] leading-snug text-destructive" role="alert">
          {note}
        </p>
      ) : null}

      {services.length > 0 ? (
        <p className="mt-1 pl-4 font-mono text-[10px] tabular-nums text-muted-foreground">
          {running}/{services.length} svc
          {live && cpu > 0 ? ` · ${Math.round(cpu * 10) / 10}% · ${formatMem(memMb)}` : ''}
          {broken ? (
            <>
              {' · '}
              <button
                type="button"
                className="text-destructive underline-offset-2 hover:underline"
                disabled={action.pending !== null}
                onClick={() => action.run(`svc:${broken}`, () => onService(worktree.id, broken, 'restart'))}
              >
                restart {broken}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

/** The first service holding the worktree back, which is the one worth offering to restart. */
function brokenService(worktree: Worktree): string | undefined {
  return worktree.environment.services.find((service) => !service.excluded && ['unhealthy', 'exited', 'failed'].includes(service.status))?.name
}
