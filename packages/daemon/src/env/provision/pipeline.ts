/**
 * The provisioning saga runner: walks the steps in order, records status/duration/detail per
 * step, stops at the first failure and leaves the run resumable from that step. Steps are
 * idempotent so "retry from here" and "re-run setup" reuse the same code.
 */
import { PROVISION_STEPS, type ProvisionRun, type ProvisionStep, type ProvisionStepName } from '@canopy/shared'

import { newId, now } from '../../lib/ids'
import type { ProvisionContext, ProvisionStepImpl } from '../types'

export const stepIndex = (name: ProvisionStepName): number => PROVISION_STEPS.indexOf(name)

/**
 * A new run starting at `from`. Steps before `from` keep the previous run's outcome when it
 * was `done`/`skipped` (they are not re-executed); otherwise they are marked skipped.
 */
export function newRun(from: ProvisionStepName, previous: ProvisionRun | null): ProvisionRun {
  const start = stepIndex(from)
  const steps: ProvisionStep[] = PROVISION_STEPS.map((name, index) => {
    const prior = previous?.steps.find((step) => step.name === name)
    if (index < start) {
      return prior && (prior.status === 'done' || prior.status === 'skipped')
        ? prior
        : { name, status: 'skipped', startedAt: null, durationMs: null, detail: 'kept from earlier run', error: null }
    }
    return { name, status: 'pending', startedAt: null, durationMs: null, detail: null, error: null }
  })
  return { id: newId(), status: 'running', steps, startedAt: now(), finishedAt: null }
}

export interface PipelineOutcome {
  run: ProvisionRun
  failedStep: ProvisionStepName | null
  error: string | null
}

/**
 * Executes the pending steps of `run`. `onUpdate` fires after every status change with a fresh
 * copy so callers can emit events; the returned run is final (done or failed).
 */
export async function runPipeline(
  steps: ProvisionStepImpl[],
  ctx: ProvisionContext,
  run: ProvisionRun,
  onUpdate: (run: ProvisionRun) => void
): Promise<PipelineOutcome> {
  const byName = new Map(steps.map((step) => [step.name, step] as const))
  const update = (name: ProvisionStepName, patch: Partial<ProvisionStep>): void => {
    run = { ...run, steps: run.steps.map((step) => (step.name === name ? { ...step, ...patch } : step)) }
    onUpdate(run)
  }

  for (const step of run.steps) {
    if (step.status !== 'pending') continue
    if (ctx.signal.aborted) {
      run = { ...run, status: 'failed', finishedAt: now() }
      update(step.name, { status: 'failed', error: 'cancelled' })
      return { run, failedStep: step.name, error: 'cancelled' }
    }
    const impl = byName.get(step.name)
    if (!impl) {
      update(step.name, { status: 'skipped', detail: 'no implementation' })
      continue
    }
    const applies = impl.applies(ctx)
    if (!applies.run) {
      ctx.logs.sys(`${step.name}: skipped — ${applies.reason}`)
      update(step.name, { status: 'skipped', detail: applies.reason })
      continue
    }
    const startedAt = now()
    ctx.logs.sys(`▸ ${step.name}`)
    update(step.name, { status: 'active', startedAt, error: null })
    try {
      const { detail } = await impl.run(ctx)
      const durationMs = now() - startedAt
      ctx.logs.sys(`✓ ${step.name} (${durationMs}ms)${detail ? ` — ${detail}` : ''}`)
      update(step.name, { status: 'done', durationMs, detail: detail || null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logs.err(`✗ ${step.name}: ${message}`)
      run = { ...run, status: 'failed', finishedAt: now() }
      update(step.name, { status: 'failed', durationMs: now() - startedAt, error: message })
      return { run, failedStep: step.name, error: message }
    }
  }
  run = { ...run, status: 'done', finishedAt: now() }
  onUpdate(run)
  return { run, failedStep: null, error: null }
}

/** Where a retry should resume: the failed step of the last run, else the first step after create. */
export function resumePoint(previous: ProvisionRun | null): ProvisionStepName {
  const failed = previous?.steps.find((step) => step.status === 'failed')
  return failed?.name ?? 'copy-files'
}
