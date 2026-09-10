import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Circle, RotateCw, X } from 'lucide-react'
import { Link } from 'wouter'

import { PROVISION_LOG, formatMs, type ProvisionStep, type Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useProvisionWorktree } from '@/lib/api-hooks'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import { LogsView } from './logs-view'

function StepIcon({ status }: { status: ProvisionStep['status'] }): React.JSX.Element {
  if (status === 'done') return <Check className="size-3.5 shrink-0 text-(--nessa-diff-addition)" />
  if (status === 'failed') return <X className="size-3.5 shrink-0 text-destructive" />
  if (status === 'active') return <RotateCw className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  return <Circle className="size-3.5 shrink-0 text-muted-foreground/40" />
}

/** "This project has no valid canopy.yaml" with the reasons and a way to fix it. */
function ConfigNote({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const { configErrors } = worktree.environment
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border p-3">
      <p className="text-xs">
        This project has no valid <span className="font-mono">canopy.yaml</span> — nothing to provision yet.
      </p>
      {configErrors.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {configErrors.map((error) => (
            <li key={error} className="font-mono text-[11px] text-destructive">
              {error}
            </li>
          ))}
        </ul>
      ) : null}
      <Link
        href={`/projects/${worktree.projectId}/settings?tab=yaml`}
        className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Edit canopy.yaml in project settings
      </Link>
    </div>
  )
}

/**
 * The provisioning saga: one row per step with what it did and how long it took, the failed
 * step's error with a resume button, and the live `provision` output on demand.
 */
export function PipelinePanel({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const env = worktree.environment
  const provision = useProvisionWorktree(worktree.id)
  const [showOutput, setShowOutput] = useState(false)
  const run = env.provisioning
  const steps = run?.steps ?? []
  const failed = steps.some((step) => step.status === 'failed')
  const settled = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length
  const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
  const running = run?.status === 'running'

  const output = (
    <div className="mt-2 flex min-h-0 flex-col gap-2">
      <Button variant="ghost" size="sm" className="h-7 self-start px-1.5 text-xs text-muted-foreground" aria-expanded={showOutput} onClick={() => setShowOutput(!showOutput)}>
        {showOutput ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {showOutput ? 'Hide output' : 'Show output'}
      </Button>
      {showOutput ? <LogsView worktreeId={worktree.id} service={PROVISION_LOG} className="min-h-40" /> : null}
    </div>
  )

  if (!run) {
    return (
      <div className="flex flex-col gap-3 px-3 py-3">
        {env.configured ? null : <ConfigNote worktree={worktree} />}
        {env.state === 'none' ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-xs text-muted-foreground">Canopy has never provisioned this worktree — no ports, databases or env file yet.</p>
            <Button size="sm" className="h-8" disabled={!env.configured || provision.isPending} onClick={() => provision.mutate({})}>
              {provision.isPending ? <RotateCw className="animate-spin" /> : null}
              {provision.isPending ? 'Provisioning…' : 'Provision'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {env.provisionedAt ? `Provisioned ${relativeTime(env.provisionedAt)} — no step detail was recorded.` : 'No provisioning run recorded for this worktree.'}
          </p>
        )}
        <ErrorNote error={provision.error} />
        {output}
      </div>
    )
  }

  return (
    <div className="flex flex-col px-3 py-1.5">
      <div className="flex items-center gap-2 py-1">
        <Badge variant={failed ? 'destructive' : 'outline'} className="font-mono text-[10px]">
          {failed ? 'failed' : running ? `${settled}/${steps.length}…` : `${settled}/${steps.length} ✓ · ${formatMs(total)}`}
        </Badge>
        {run.finishedAt ? <span className="font-mono text-[10px] text-muted-foreground">{relativeTime(run.finishedAt)}</span> : null}
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {steps.map((step) => (
          <div key={step.name} className="flex flex-col gap-1 py-1.5">
            <div className="flex items-center gap-2.5 text-xs">
              <StepIcon status={step.status} />
              <span className={cn('w-36 shrink-0 font-mono', (step.status === 'pending' || step.status === 'skipped') && 'text-muted-foreground')}>{step.name}</span>
              <span className="hidden min-w-0 flex-1 truncate font-mono text-muted-foreground/70 sm:inline" title={step.detail ?? undefined}>
                {step.status === 'skipped' ? 'skipped' : (step.detail ?? '')}
              </span>
              {step.durationMs !== null ? <span className="ml-auto shrink-0 font-mono text-muted-foreground tabular-nums">{formatMs(step.durationMs)}</span> : null}
            </div>
            {step.error ? (
              <div className="ml-6 flex flex-col gap-1.5 pb-1">
                <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 font-mono text-[11px] whitespace-pre-wrap text-destructive">{step.error}</p>
                <Button variant="outline" size="sm" className="self-start" disabled={provision.isPending || running} onClick={() => provision.mutate({ from: step.name })}>
                  <RotateCw className={provision.isPending ? 'animate-spin' : undefined} />
                  {provision.isPending ? 'Retrying…' : 'Retry from here'}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <ErrorNote error={provision.error} className="mt-2" />
      {output}
    </div>
  )
}
