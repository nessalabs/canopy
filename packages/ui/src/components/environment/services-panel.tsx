import { RotateCw } from 'lucide-react'

import { SERVICE_DOT, SERVICE_LABEL, formatMem, type ServiceInfo, type Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { useServiceAction } from '@/lib/api-hooks'
import { uptime } from '@/lib/environment-ui'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/providers/platform'

/** Statuses from which stop/restart make sense; everything else offers start. */
const UP: ServiceInfo['status'][] = ['starting', 'healthy', 'unhealthy', 'restarting']

function PortLink({ port }: { port: number }): React.JSX.Element {
  const { openExternal } = usePlatform()
  const url = `http://localhost:${port}`
  return (
    <a
      className="shrink-0 font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        openExternal(url)
      }}
    >
      :{port}
    </a>
  )
}

function ServiceRow({ worktree, service, onShowLogs }: { worktree: Worktree; service: ServiceInfo; onShowLogs: (service: string) => void }): React.JSX.Element {
  const action = useServiceAction(worktree.id)
  const pending = action.isPending && action.variables?.service === service.name
  const up = UP.includes(service.status)
  const transitioning = service.status === 'stopping' || pending
  const running = uptime(service.startedAt)

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-3">
        <StatusDot status={service.excluded ? 'idle' : SERVICE_DOT[service.status]} />
        <span className={cn('w-20 shrink-0 truncate font-mono text-sm', service.excluded && 'text-muted-foreground line-through')} title={service.name}>
          {service.name}
        </span>
        {service.excluded || service.ports.length === 0 ? (
          <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">—</span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5">
            {service.ports.map((port) => (
              <PortLink key={port.name} port={port.port} />
            ))}
          </span>
        )}
        {service.runtime !== 'host' ? (
          <Badge variant="secondary" className="shrink-0 text-[9px]">
            {service.runtime === 'compose' ? 'compose' : 'docker'}
          </Badge>
        ) : null}
        <span className="hidden w-16 shrink-0 truncate font-mono text-[11px] text-muted-foreground lg:inline">
          {service.excluded ? 'off' : service.status === 'healthy' && running ? `up ${running}` : SERVICE_LABEL[service.status].toLowerCase()}
        </span>
        {service.cpuPct !== undefined ? (
          <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground xl:inline">
            {service.cpuPct}% · {formatMem(service.memMb ?? 0)}
          </span>
        ) : null}
        {service.restarts > 0 ? (
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline" title={`${service.restarts} restarts`}>
            ↻{service.restarts}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {service.excluded ? null : up ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={transitioning}
                onClick={() => action.mutate({ service: service.name, action: 'restart' })}
              >
                {pending ? <RotateCw className="animate-spin" /> : null}
                Restart
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={transitioning} onClick={() => action.mutate({ service: service.name, action: 'stop' })}>
                Stop
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={transitioning} onClick={() => action.mutate({ service: service.name, action: 'start' })}>
              {pending ? <RotateCw className="animate-spin" /> : null}
              Start
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onShowLogs(service.name)}>
            Logs
          </Button>
        </span>
      </div>
      {service.lastError ? <p className="ml-6 truncate font-mono text-[11px] text-destructive" title={service.lastError}>{service.lastError}</p> : null}
      <ErrorNote error={action.error} className="ml-6" />
    </div>
  )
}

/** Every service canopy.yaml declares for this worktree, with its ports, health and controls. */
export function ServicesPanel({ worktree, onShowLogs }: { worktree: Worktree; onShowLogs: (service: string) => void }): React.JSX.Element {
  const services = worktree.environment.services

  if (services.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
        {worktree.environment.configured ? 'canopy.yaml declares no services.' : 'No canopy.yaml — nothing runs for this worktree yet.'}
      </p>
    )
  }

  return (
    <div className="flex flex-col divide-y divide-border/60 px-3 py-1">
      {services.map((service) => (
        <ServiceRow key={service.name} worktree={worktree} service={service} onShowLogs={onShowLogs} />
      ))}
    </div>
  )
}
