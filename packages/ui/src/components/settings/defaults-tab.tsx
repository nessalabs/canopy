/** Defaults the new-worktree form starts from: runtime, autostart, env, branch prefix, DB source. */
import { Plus } from 'lucide-react'

import type { ProjectEnvVar, ProjectSettings, WorktreeDefaults } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'

import { RemoveButton, Row, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

/** Worktree defaults tab. */
export function DefaultsTab({ draft }: { draft: Draft<ProjectSettings> }): React.JSX.Element {
  const defaults = draft.settings?.defaults
  const env = defaults?.env ?? []

  const setDefaults = (patch: Partial<WorktreeDefaults>): void => draft.update((current) => ({ ...current, defaults: { ...current.defaults, ...patch } }))
  const setEnv = (next: ProjectEnvVar[]): void => setDefaults({ env: next })

  return (
    <div className="flex flex-col gap-5">
      <TabHeader title="Worktree defaults" description="What the new-worktree form is pre-filled with. Every one of these can still be overridden per worktree." status={draft.status} />

      <Row label="Default runtime" hint="Per-service follows each service's runtime in canopy.yaml; host and docker force every service that supports it.">
        <SegmentedControl
          value={defaults?.runtime ?? 'per-service'}
          onValueChange={(value) => setDefaults({ runtime: value as WorktreeDefaults['runtime'] })}
          aria-label="Default runtime"
        >
          <SegmentedControlOption value="per-service">Per-service</SegmentedControlOption>
          <SegmentedControlOption value="host">Host</SegmentedControlOption>
          <SegmentedControlOption value="docker">Docker</SegmentedControlOption>
        </SegmentedControl>
      </Row>

      <Row label="Start services after create" hint="Drives which button is the primary one on the new-worktree screen.">
        <Switch checked={defaults?.autoStart ?? false} disabled={!defaults} onCheckedChange={(checked) => setDefaults({ autoStart: checked })} aria-label="Start services after create" />
      </Row>

      <Row label="Default database source" hint="Where each worktree's database forks start from. Forking from a sibling worktree stays a per-worktree choice.">
        <SegmentedControl value={defaults?.dbSource ?? 'template'} onValueChange={(value) => setDefaults({ dbSource: value as WorktreeDefaults['dbSource'] })} aria-label="Default database source">
          <SegmentedControlOption value="template">Seed template</SegmentedControlOption>
          <SegmentedControlOption value="empty">Empty</SegmentedControlOption>
        </SegmentedControl>
      </Row>

      <Row label="Default env overrides" hint="Layered over canopy.yaml env for every worktree of this project. Secret values are masked in the UI.">
        <div className="flex flex-col gap-2">
          {env.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Default env key ${index + 1}`}
                className="w-44 font-mono text-xs"
                placeholder="KEY"
                value={row.key}
                onChange={(event) => setEnv(env.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))}
              />
              <Input
                aria-label={`Default env value ${index + 1}`}
                className="min-w-40 flex-1 font-mono text-xs"
                placeholder="value"
                type={row.secret ? 'password' : 'text'}
                value={row.value}
                onChange={(event) => setEnv(env.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={row.secret ?? false}
                  aria-label={`Treat default env ${index + 1} as secret`}
                  onChange={(event) => setEnv(env.map((entry, i) => (i === index ? { ...entry, secret: event.currentTarget.checked } : entry)))}
                />
                secret
              </label>
              <RemoveButton label={`Remove default env row ${index + 1}`} onClick={() => setEnv(env.filter((_, i) => i !== index))} />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={!defaults} onClick={() => setEnv([...env, { key: '', value: '' }])}>
            <Plus /> Add variable
          </Button>
        </div>
      </Row>

      <Row label="Branch prefix" hint="Prepended to new branch names, e.g. igaurab/ → igaurab/fix-auth.">
        <Input
          className="max-w-52 font-mono text-xs"
          placeholder="none"
          aria-label="Branch prefix"
          value={defaults?.branchPrefix ?? ''}
          disabled={!defaults}
          onChange={(event) => setDefaults({ branchPrefix: event.target.value })}
        />
      </Row>

      <p className="text-xs text-muted-foreground">
        Where worktrees are created lives on the <span className="font-medium">Worktrees</span> tab — it is one template for the whole project.
      </p>

      <ErrorNote error={draft.error} />
    </div>
  )
}
