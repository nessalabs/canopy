/** Provisioning & caches: which local files travel into a worktree and how dependency directories get there. */
import { Plus } from 'lucide-react'

import type { CacheRule, CacheStrategy, CopyFileRule, Project, ProjectSettings } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useProjectEnvironment } from '@/lib/api-hooks'
import { CACHE_STRATEGY_HINT } from '@/lib/settings-ui'

import { RemoveButton, Row, ScopeNote, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

const CACHE_STRATEGIES: CacheStrategy[] = ['clone', 'copy', 'symlink', 'fresh']

/** Provisioning & caches tab. */
export function CachesTab({ project, draft }: { project: Project; draft: Draft<ProjectSettings> }): React.JSX.Element {
  const preview = useProjectEnvironment(project.id)
  const settings = draft.settings

  const copyFiles = settings?.copyFiles ?? []
  const caches = settings?.caches
  const rules = caches?.rules ?? []

  const setCopyFiles = (next: CopyFileRule[]): void => draft.update((current) => ({ ...current, copyFiles: next }))
  const setRules = (next: CacheRule[]): void => draft.update((current) => ({ ...current, caches: { ...current.caches, rules: next } }))
  const setCaches = (patch: Partial<ProjectSettings['caches']>): void => draft.update((current) => ({ ...current, caches: { ...current.caches, ...patch } }))

  const candidates = (preview.data?.detectedCopyCandidates ?? []).filter((pattern) => !copyFiles.some((rule) => rule.pattern === pattern))
  const detectedCaches = (preview.data?.detectedCaches ?? []).filter((detected) => !rules.some((rule) => rule.path === detected.path))
  const setup = preview.data?.setup ?? []

  return (
    <div className="flex flex-col gap-5">
      <TabHeader title="Provisioning & caches" description="What a brand-new worktree inherits from the primary checkout before setup runs." status={draft.status} />

      <ScopeNote>
        <code>git worktree add</code> gives you tracked files and nothing else — no <code>.env</code>, no <code>node_modules</code>. These rules are Canopy's, stored on this
        daemon, and run as the <code>copy-files</code> and <code>link-caches</code> steps of provisioning.
      </ScopeNote>

      <Row label="Files copied into new worktrees" hint="Globs relative to the repo root. Untracked and gitignored files don't come along on their own.">
        <div className="flex flex-col gap-2">
          {copyFiles.map((rule, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Copy pattern ${index + 1}`}
                className="max-w-64 font-mono text-xs"
                placeholder=".env.local"
                value={rule.pattern}
                onChange={(event) => setCopyFiles(copyFiles.map((row, i) => (i === index ? { ...row, pattern: event.target.value } : row)))}
              />
              <Select value={rule.strategy} onValueChange={(value) => setCopyFiles(copyFiles.map((row, i) => (i === index ? { ...row, strategy: value as CopyFileRule['strategy'] } : row)))}>
                <SelectTrigger className="w-28" aria-label={`Copy strategy for ${rule.pattern || `rule ${index + 1}`}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="copy">copy</SelectItem>
                  <SelectItem value="symlink">symlink</SelectItem>
                </SelectContent>
              </Select>
              {rule.detected ? (
                <Badge variant="secondary" className="text-[10px]">
                  detected
                </Badge>
              ) : null}
              <RemoveButton label={`Remove copy rule ${index + 1}`} onClick={() => setCopyFiles(copyFiles.filter((_, i) => i !== index))} />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={!settings} onClick={() => setCopyFiles([...copyFiles, { pattern: '', strategy: 'copy' }])}>
            <Plus /> Add pattern
          </Button>
          {candidates.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Present in the primary checkout but not listed:
              {candidates.map((pattern) => (
                <Button
                  key={pattern}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 font-mono text-xs"
                  onClick={() => setCopyFiles([...copyFiles, { pattern, strategy: 'copy', detected: true }])}
                >
                  <Plus className="size-3" />
                  {pattern}
                </Button>
              ))}
            </p>
          ) : null}
        </div>
      </Row>

      <Row label="Dependency & build caches" hint="One rule per directory. clone is a copy-on-write clone where the filesystem supports it and a plain copy where it does not.">
        <div className="flex flex-col gap-2">
          <div className="hidden gap-2 px-1 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase sm:flex">
            <span className="flex-1">path</span>
            <span className="w-32">strategy</span>
            <span className="w-40">tags</span>
            <span className="w-7" />
          </div>
          {rules.map((rule, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Cache path ${index + 1}`}
                className="min-w-40 flex-1 font-mono text-xs"
                placeholder="node_modules"
                value={rule.path}
                onChange={(event) => setRules(rules.map((row, i) => (i === index ? { ...row, path: event.target.value } : row)))}
              />
              <Select value={rule.strategy} onValueChange={(value) => setRules(rules.map((row, i) => (i === index ? { ...row, strategy: value as CacheStrategy } : row)))}>
                <SelectTrigger className="w-32" aria-label={`Cache strategy for ${rule.path || `rule ${index + 1}`}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CACHE_STRATEGIES.map((strategy) => (
                    <SelectItem key={strategy} value={strategy}>
                      {strategy}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="flex w-40 flex-wrap gap-1">
                {rule.ecosystem ? (
                  <Badge variant="outline" className="text-[10px]">
                    {rule.ecosystem}
                  </Badge>
                ) : null}
                {rule.detected ? (
                  <Badge variant="secondary" className="text-[10px]">
                    detected
                  </Badge>
                ) : null}
              </span>
              <RemoveButton label={`Remove cache rule ${index + 1}`} onClick={() => setRules(rules.filter((_, i) => i !== index))} />
              <p className="w-full text-[10px] text-muted-foreground sm:pl-1">{CACHE_STRATEGY_HINT[rule.strategy]}</p>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!settings} onClick={() => setRules([...rules, { path: '', strategy: 'clone' }])}>
              <Plus /> Add rule
            </Button>
            {detectedCaches.length > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setRules([...rules, ...detectedCaches.map((rule) => ({ ...rule, detected: true }))])}>
                <Plus /> Add detected ({detectedCaches.length})
              </Button>
            ) : null}
          </div>
          {detectedCaches.length > 0 ? (
            <p className="font-mono text-[11px] text-muted-foreground">{detectedCaches.map((rule) => `${rule.path} (${rule.strategy})`).join(' · ')}</p>
          ) : null}
        </div>
      </Row>

      <Row label="Reinstall when the lockfile differs" hint="After a clone or copy, run the ecosystem's install if this branch's lockfile does not match the source's. Fixes the branch-changed-deps hole.">
        <Switch
          checked={caches?.reinstallOnLockChange ?? false}
          disabled={!caches}
          onCheckedChange={(checked) => setCaches({ reinstallOnLockChange: checked })}
          aria-label="Reinstall when the lockfile differs"
        />
      </Row>

      <Row label="Use machine-wide package stores" hint="Point package managers at the shared uv cache and pnpm store so a fresh install hardlinks instead of downloading.">
        <Switch checked={caches?.sharedStores ?? false} disabled={!caches} onCheckedChange={(checked) => setCaches({ sharedStores: checked })} aria-label="Use machine-wide package stores" />
      </Row>

      <Row label="Setup commands" hint="From canopy.yaml — the run-setup step executes them in order with the resolved env. Edit them on the canopy.yaml tab.">
        {setup.length === 0 ? (
          <p className="text-xs text-muted-foreground">{preview.isPending ? 'Reading canopy.yaml…' : 'No setup: steps in canopy.yaml.'}</p>
        ) : (
          <ol className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3 font-mono text-xs text-muted-foreground">
            {setup.map((command, index) => (
              <li key={`${command}-${index}`}>
                {index + 1}. {command}
              </li>
            ))}
          </ol>
        )}
      </Row>

      <ErrorNote error={preview.error} />
      <ErrorNote error={draft.error} />
    </div>
  )
}
