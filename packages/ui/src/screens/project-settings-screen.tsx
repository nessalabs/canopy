import { useState } from 'react'
import { useLocation } from 'wouter'

import type { Project } from '@canopy/shared'

import { ComingSoon } from '@/components/coming-soon'
import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBranches, useProjects, useRemoveProject, useUpdateProject } from '@/lib/api-hooks'

function GeneralSection({ project }: { project: Project }): React.JSX.Element {
  const branches = useBranches(project.id)
  const update = useUpdateProject(project.id)
  const [name, setName] = useState(project.name)
  const [defaultBase, setDefaultBase] = useState(project.defaultBase)
  const dirty = name !== project.name || defaultBase !== project.defaultBase

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription className="font-mono text-xs">{project.path}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-xs text-muted-foreground">Project name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} className="max-w-sm font-mono" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-xs text-muted-foreground">Default base branch (ahead/behind and "vs base" diffs compare against it)</span>
          <Select value={defaultBase} onValueChange={setDefaultBase}>
            <SelectTrigger className="max-w-sm font-mono" aria-label="Default base branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(branches.data?.branches ?? [{ name: project.defaultBase }]).map((b) => (
                <SelectItem key={b.name} value={b.name} className="font-mono">
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
          {project.ecosystems.map((e) => (
            <span key={e} className="rounded border border-border px-1.5 py-0.5 font-mono">
              {e}
            </span>
          ))}
          <span className="rounded border border-border px-1.5 py-0.5 font-mono">{project.hasCanopyYaml ? 'canopy.yaml' : 'no canopy.yaml'}</span>
        </div>
        <ErrorNote error={update.error} />
        <div>
          <Button size="sm" disabled={!dirty || update.isPending} onClick={() => update.mutate({ name: name.trim(), defaultBase })}>
            Save changes
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function DangerZone({ project }: { project: Project }): React.JSX.Element {
  const [, navigate] = useLocation()
  const remove = useRemoveProject()
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>Unregistering forgets the project and its review comments. Nothing on disk is touched — worktrees and branches stay where they are.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ErrorNote error={remove.error} />
        <div>
          <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(project.id, { onSuccess: () => navigate('/') })}>
            Unregister project
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function ProjectSettingsScreen({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useProjects().data?.find((p) => p.id === projectId)
  if (!project) return <p className="p-6 text-sm text-muted-foreground">Project not found.</p>

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Settings <span className="font-mono text-muted-foreground">· {project.name}</span>
      </h1>
      <GeneralSection key={project.id + project.name + project.defaultBase} project={project} />
      <ComingSoon title="canopy.yaml, provisioning, worktree defaults, cleanup" detail="These sections light up with the Environment work." />
      <DangerZone project={project} />
    </div>
  )
}
