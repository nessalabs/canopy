import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { logTime } from '@/lib/environment-ui'
import { useServiceLogs, type ServiceLogs } from '@/lib/use-service-logs'
import { cn } from '@/lib/utils'

const STATE_LABEL: Record<ServiceLogs['state'], string> = {
  loading: 'loading',
  live: 'live',
  reconnecting: 'reconnecting',
  ended: 'ended'
}

const STATE_CLASS: Record<ServiceLogs['state'], string> = {
  loading: 'text-muted-foreground',
  live: 'text-(--nessa-diff-addition)',
  reconnecting: 'text-destructive',
  ended: 'text-muted-foreground'
}

/**
 * One service's output: REST backfill then a live follow, newest at the bottom. The follow
 * toggle pins the viewport to the tail; turning it off lets the reader scroll back while
 * lines keep arriving.
 */
export function LogsView({
  worktreeId,
  service,
  toolbarLeading,
  className
}: {
  worktreeId: string
  service: string
  /** Rendered at the start of the toolbar row — the panel puts its service picker here. */
  toolbarLeading?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const logs = useServiceLogs(worktreeId, service)
  const [follow, setFollow] = useState(true)
  const areaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!follow) return
    const viewport = areaRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [logs.lines, follow])

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-2', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {toolbarLeading}
        <span className={cn('ml-auto font-mono text-[10px]', STATE_CLASS[logs.state])}>{STATE_LABEL[logs.state]}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-6', follow ? 'text-foreground' : 'text-muted-foreground')}
              aria-pressed={follow}
              aria-label={follow ? 'Stop following output' : 'Follow output'}
              onClick={() => setFollow(!follow)}
            >
              <ArrowDownToLine className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{follow ? 'Following — click to pause' : 'Follow new output'}</TooltipContent>
        </Tooltip>
      </div>
      <ErrorNote error={logs.error} />
      <ScrollArea ref={areaRef} className="min-h-24 flex-1 rounded-lg border border-border bg-surface-sunken">
        <div className="p-2.5 font-mono text-[11px] leading-[1.6]">
          {logs.truncated ? <p className="pb-1 text-muted-foreground/60">older lines not shown</p> : null}
          {logs.lines.length === 0 ? (
            <p className="text-muted-foreground">
              {logs.state === 'loading' ? 'Reading output…' : `No output yet — ${service} writes here while it runs.`}
            </p>
          ) : (
            logs.lines.map((line, index) => (
              <div key={`${line.offset}:${index}`} className="flex gap-2 whitespace-pre-wrap">
                <span className="shrink-0 text-muted-foreground/50 tabular-nums">{logTime(line.ts)}</span>
                <span className={cn('min-w-0', line.stream === 'err' && 'text-destructive', line.stream === 'sys' && 'text-muted-foreground italic')}>
                  {line.stream === 'sys' ? `canopy: ${line.text}` : line.text}
                </span>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
