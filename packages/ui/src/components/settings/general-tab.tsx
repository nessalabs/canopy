/** General project settings: identity, base branch, auto-fetch, and what Canopy detected. */
import { useState } from 'react'

import type { Project, ProjectSettings } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useBranches, useUpdateProject } from '@/lib/api-hooks'

import { Row, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'
import { plural } from '@/lib/format'

/** Name and default base live on the project row, so they keep an explicit Save. */
export function GeneralTab({ project, draft }: { project: Project; draft: Draft<ProjectSettings> }): React.JSX.Element {
  const branches = useBranches(project.id)
  const update = useUpdateProject(project.id)
  const [name, setName] = useState(project.name)
  const [defaultBase, setDefaultBase] = useState(project.defaultBase)
  const settings = draft.settings
  const dirty = name.trim() !== project.name || defaultBase !== project.defaultBase
  const report = project.config

  return (
    <div className="flex flex-col gap-5">
      <TabHeader title="General" description="Identity of the project and how Canopy keeps its base branch fresh." status={draft.status} />

      <Row label="Project name">
        <Input value={name} onChange={(event) => setName(event.target.value)} className="max-w-sm font-mono" aria-label="Project name" />
      </Row>

      <Row label="Repository path" hint="The primary checkout. Every worktree of this repo is created from it.">
        <p className="font-mono text-sm text-muted-foreground">{project.path}</p>
      </Row>

      <Row label="Default base branch" hint="New worktrees branch from here, and ahead/behind and “vs base” diffs compare against it.">
        <Select value={defaultBase} onValueChange={setDefaultBase}>
          <SelectTrigger className="w-64 font-mono" aria-label="Default base branch">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(branches.data?.branches ?? [{ name: project.defaultBase }]).map((branch) => (
              <SelectItem key={branch.name} value={branch.name} className="font-mono">
                {branch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <ErrorNote error={update.error} />
      <div>
        <Button size="sm" disabled={!dirty || update.isPending} onClick={() => update.mutate({ name: name.trim(), defaultBase })}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <Row label="Auto-fetch the base branch" hint="Keeps “new worktree from main” meaning fresh main, not last week's.">
        <div className="flex items-center gap-3">
          <Switch
            checked={settings?.autoFetch ?? false}
            disabled={!settings}
            onCheckedChange={(checked) => draft.update((current) => ({ ...current, autoFetch: checked }))}
            aria-label="Auto-fetch the base branch"
          />
          <Select
            value={settings?.autoFetchInterval ?? '15m'}
            onValueChange={(value) => draft.update((current) => ({ ...current, autoFetchInterval: value as ProjectSettings['autoFetchInterval'] }))}
          >
            <SelectTrigger className="w-36" aria-label="Fetch interval" disabled={!settings?.autoFetch}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5m">Every 5 min</SelectItem>
              <SelectItem value="15m">Every 15 min</SelectItem>
              <SelectItem value="1h">Every hour</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Row>

      <Row label="Detected" hint="Ecosystems drive the default cache rules; the canopy.yaml chip reflects the daemon's own lint.">
        <div className="flex flex-wrap gap-1.5">
          {project.ecosystems.map((ecosystem) => (
            <Badge key={ecosystem} variant="secondary" className="text-[10px]">
              {ecosystem}
            </Badge>
          ))}
          {project.compose ? (
            <Badge variant="outline" className="text-[10px]">
              compose: {project.compose.services.join(', ') || project.compose.file}
            </Badge>
          ) : null}
          <Badge variant={report.present ? (report.valid ? 'outline' : 'destructive') : 'outline'} className="font-mono text-[10px]">
            {report.present ? (report.valid ? 'canopy.yaml' : 'canopy.yaml — errors') : 'no canopy.yaml'}
          </Badge>
          {report.valid ? (
            <>
              <Badge variant="outline" className="text-[10px]">
                {report.services} services
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {report.ports} ports
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {plural(report.databases, 'database')}
              </Badge>
            </>
          ) : null}
        </div>
      </Row>

      <ErrorNote error={draft.error} />
    </div>
  )
}
