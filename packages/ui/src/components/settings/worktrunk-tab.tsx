/** Worktrunk (`wt`) integration: the path template, the lifecycle hooks, and the `.config/wt.toml` Canopy renders. */
import { Check, Plus, TriangleAlert } from 'lucide-react'

import { WORKTRUNK_HOOKS, renderWorktreePath, type Project, type ProjectSettings, type WorktrunkHook, type WorktrunkHookRule } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/ui/code-block'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useHost, useProjectWtToml, useWriteProjectWtToml } from '@/lib/api-hooks'
import { WORKTREE_PATH_VARS, WORKTRUNK_HOOK_HINT } from '@/lib/settings-ui'

import { RemoveButton, Row, ScopeNote, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

/** Where a worktree of this project would land, with a placeholder branch. */
function pathExample(template: string, root: string, project: Project): string {
  if (template.trim() === '') return ''
  return renderWorktreePath(template, { root, repo: project.name, repoPath: project.path, name: 'feat-x', branch: 'feat/x' })
}

function HookRow({
  rule,
  index,
  onChange,
  onRemove
}: {
  rule: WorktrunkHookRule
  index: number
  onChange: (next: WorktrunkHookRule) => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={rule.hook} onValueChange={(value) => onChange({ ...rule, hook: value as WorktrunkHook })}>
          <SelectTrigger className="w-36 font-mono text-xs" aria-label={`Hook ${index + 1} event`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKTRUNK_HOOKS.map((hook) => (
              <SelectItem key={hook} value={hook} className="font-mono text-xs">
                {hook}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-32 font-mono text-xs"
          placeholder="name"
          aria-label={`Hook ${index + 1} name`}
          value={rule.name ?? ''}
          onChange={(event) => onChange({ ...rule, name: event.target.value === '' ? undefined : event.target.value })}
        />
        {rule.canopy ? (
          <Badge variant="secondary" className="shrink-0 text-[10px]" title="Canopy wires this hook so worktrees created in a terminal provision too.">
            canopy
          </Badge>
        ) : null}
        <RemoveButton label={`Remove hook ${index + 1}`} onClick={onRemove} />
      </div>
      <Input
        className="font-mono text-xs"
        placeholder="command to run"
        aria-label={`Hook ${index + 1} command`}
        value={rule.command}
        onChange={(event) => onChange({ ...rule, command: event.target.value })}
      />
      <p className="text-[10px] text-muted-foreground">{WORKTRUNK_HOOK_HINT[rule.hook]}</p>
    </div>
  )
}

/** The Worktrunk tab. */
export function WorktrunkTab({ project, draft }: { project: Project; draft: Draft<ProjectSettings> }): React.JSX.Element {
  const host = useHost()
  const preview = useProjectWtToml(project.id)
  const write = useWriteProjectWtToml(project.id)
  const settings = draft.settings
  const wt = settings?.worktrunk
  const tool = host.data?.worktrunk

  const setWt = (patch: Partial<ProjectSettings['worktrunk']>): void => draft.update((current) => ({ ...current, worktrunk: { ...current.worktrunk, ...patch } }))
  const setHooks = (hooks: WorktrunkHookRule[]): void => setWt({ hooks })

  const example = wt && host.data ? pathExample(wt.worktreePath, host.data.worktreeRoot, project) : ''
  const syncBadge = preview.data ? (!preview.data.exists ? 'not in repo' : preview.data.inSync ? 'in sync' : 'differs from repo') : '…'

  return (
    <div className="flex flex-col gap-5">
      <TabHeader title="Worktrunk" description="How Canopy drives the `wt` CLI for this project." status={draft.status} />

      <ScopeNote>
        Canopy creates and removes worktrees through <code>wt</code> when it is installed, and falls back to plain <code>git worktree</code> otherwise. Hooks and the{' '}
        <code>[list] url</code> below belong to the repo — Canopy renders them into <code>.config/wt.toml</code> and only ever rewrites the keys it owns. The worktree location is
        a Canopy setting: it is rendered here and passed to <code>wt</code> per call, never written to the file.
      </ScopeNote>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {tool?.available ? (
          <>
            <Badge variant="outline" className="gap-1 text-[10px] text-nessa-diff-addition">
              <Check className="size-3" /> worktrunk {tool.version ?? 'installed'}
            </Badge>
            {tool.path ? <span className="font-mono text-muted-foreground">{tool.path}</span> : null}
          </>
        ) : host.isPending ? (
          <span className="text-muted-foreground">Checking for worktrunk…</span>
        ) : (
          <>
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <TriangleAlert className="size-3" /> worktrunk not found
            </Badge>
            <span className="text-muted-foreground">
              install: <code className="font-mono text-foreground">cargo install worktrunk</code> — until then Canopy uses plain git.
            </span>
          </>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Row label="Use worktrunk" hint="Off drives every worktree through plain git, hooks included.">
            <Switch
              checked={wt?.enabled ?? false}
              disabled={!wt}
              onCheckedChange={(checked) => setWt({ enabled: checked })}
              aria-label="Use worktrunk"
            />
          </Row>

          <Row label="Worktree location" hint="A Canopy template. Canopy renders it and passes the finished path to wt per call, so it is not written to .config/wt.toml. Relative results land under the daemon's worktree root.">
            <Input
              className="max-w-lg font-mono text-xs"
              value={wt?.worktreePath ?? ''}
              disabled={!wt}
              aria-label="Worktree path template"
              onChange={(event) => setWt({ worktreePath: event.target.value })}
            />
            <div className="flex flex-wrap gap-1.5">
              {WORKTREE_PATH_VARS.map((variable) => (
                <button
                  key={variable}
                  type="button"
                  disabled={!wt}
                  className="cursor-pointer rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                  title="Append to the template"
                  onClick={() => setWt({ worktreePath: `${wt?.worktreePath ?? ''}${variable}` })}
                >
                  {variable}
                </button>
              ))}
            </div>
            {example ? (
              <p className="font-mono text-[11px] text-muted-foreground">
                feat/x → <span className="text-foreground">{example}</span>
              </p>
            ) : null}
          </Row>

          <Row label="Lifecycle hooks" hint="pre-* hooks block — a non-zero exit aborts the operation; post-* hooks run in the background. Rows marked canopy are how a worktree created in a terminal reaches the daemon.">
            <div className="flex flex-col gap-2">
              {(wt?.hooks ?? []).map((rule, index) => (
                <HookRow
                  key={index}
                  rule={rule}
                  index={index}
                  onChange={(next) => setHooks((wt?.hooks ?? []).map((row, i) => (i === index ? next : row)))}
                  onRemove={() => setHooks((wt?.hooks ?? []).filter((_, i) => i !== index))}
                />
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" disabled={!wt} onClick={() => setHooks([...(wt?.hooks ?? []), { hook: 'post-start', command: '' }])}>
                <Plus /> Add hook
              </Button>
            </div>
          </Row>

          <Row label="Dev server URL in wt list" hint="Template for the url column of `wt list`. Empty leaves the key alone.">
            <Input
              className="max-w-lg font-mono text-xs"
              placeholder="http://localhost:{{ hash_port }}"
              value={wt?.listUrl ?? ''}
              disabled={!wt}
              aria-label="wt list url template"
              onChange={(event) => setWt({ listUrl: event.target.value })}
            />
          </Row>

          <Row label="Keep .config/wt.toml in sync" hint="On, Canopy rewrites the file in the primary checkout whenever these settings change. Off, the file only changes when you ask.">
            <Switch
              checked={wt?.syncProjectConfig ?? false}
              disabled={!wt}
              onCheckedChange={(checked) => setWt({ syncProjectConfig: checked })}
              aria-label="Keep .config/wt.toml in sync"
            />
          </Row>

          <ErrorNote error={draft.error} />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">rendered file</p>
            <Badge variant={preview.data?.inSync ? 'outline' : 'secondary'} className="text-[10px]">
              {syncBadge}
            </Badge>
          </div>
          <CodeBlock code={preview.data?.toml ?? '# loading…'} language="toml" filename={preview.data?.path ?? '.config/wt.toml'} />
          <ErrorNote error={preview.error} />
          <ErrorNote error={write.error} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={!preview.data || preview.data.inSync || write.isPending}
            onClick={() => write.mutate(undefined)}
          >
            {write.isPending ? 'Writing…' : 'Write to repo now'}
          </Button>
          <p className="text-xs text-muted-foreground">
            The daemon renders this from the settings on the left and merges it into whatever the file already has — unknown keys and your own hooks survive.
          </p>
        </div>
      </div>
    </div>
  )
}
