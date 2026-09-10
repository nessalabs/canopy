/** New worktree: branch + name, with the whole provisioning plan visible and overridable. */
import { useState } from 'react'
import { GitBranch, Plus, TriangleAlert, X } from 'lucide-react'
import { useLocation } from 'wouter'

import { WORKTREE_NAME_PATTERN, renderWorktreePath, type BranchSpec, type CacheSource, type CacheStrategy, type DbSource, type ProjectEnvVar } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SearchableListbox } from '@/components/ui/searchable-listbox'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBranches, useCreateWorktree, useHost, useProjectEnvironment, useProjectSettings, useProjects, useWorktrees } from '@/lib/api-hooks'
import { CACHE_DEFAULT, buildCreateInput, suggestWorktreeName, summaryBadges } from '@/lib/settings-ui'

const CACHE_STRATEGIES: CacheStrategy[] = ['clone', 'copy', 'symlink', 'fresh']

/** The new-worktree form. */
export function WorktreeCreateScreen({ projectId }: { projectId: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const project = useProjects().data?.find((candidate) => candidate.id === projectId)
  const branches = useBranches(projectId)
  const settingsQuery = useProjectSettings(projectId)
  const previewQuery = useProjectEnvironment(projectId)
  const host = useHost()
  const worktrees = useWorktrees()
  const create = useCreateWorktree(projectId)

  const [mode, setMode] = useState<BranchSpec['mode']>('new')
  const [newBranch, setNewBranch] = useState('')
  const [base, setBase] = useState<string>()
  const [existing, setExisting] = useState<string>()
  const [name, setName] = useState<string>()
  // `undefined` on these four means "still following the project default".
  const [picked, setPicked] = useState<string[]>()
  const [dbChoice, setDbChoice] = useState<DbSource>()
  const [runtimeChoice, setRuntimeChoice] = useState<'follow' | 'host' | 'docker'>()
  const [envRows, setEnvRows] = useState<ProjectEnvVar[]>([])
  const [cacheOverrides, setCacheOverrides] = useState<Record<string, CacheStrategy>>({})
  const [cacheSource, setCacheSource] = useState<CacheSource>('primary')
  const [skipSetup, setSkipSetup] = useState(false)

  const settings = settingsQuery.data
  const preview = previewQuery.data
  const configured = preview?.report.valid ?? false

  const prefix = settings?.defaults.branchPrefix ?? ''
  const baseBranch = base ?? branches.data?.defaultBranch ?? project?.defaultBase ?? 'main'
  const typed = newBranch.trim()
  const branchName = mode === 'new' ? (typed === '' ? '' : `${prefix}${typed}`) : (existing ?? '')
  const effectiveName = name ?? suggestWorktreeName(branchName)
  const nameOk = WORKTREE_NAME_PATTERN.test(effectiveName)
  const valid = branchName !== '' && nameOk
  const branch: BranchSpec = mode === 'new' ? { mode, name: branchName, base: baseBranch } : { mode, name: branchName }

  const allServices = (preview?.services ?? []).map((service) => service.name)
  const selectedServices = picked ?? allServices
  const dbSource: DbSource = dbChoice ?? settings?.defaults.dbSource ?? 'template'
  const projectRuntime = settings?.defaults.runtime === 'host' ? 'host' : settings?.defaults.runtime === 'docker' ? 'docker' : 'follow'
  const runtime = runtimeChoice ?? projectRuntime
  const cacheRules = settings?.caches.rules ?? []
  const siblings = (worktrees.data ?? []).filter((worktree) => worktree.projectId === projectId && !worktree.isMain)

  const worktreeName = (id: string): string => siblings.find((worktree) => worktree.id === id)?.name ?? 'worktree'
  const headCache = cacheRules[0]
  const summary = summaryBadges({
    services: { selected: selectedServices.length, total: allServices.length },
    ports: preview?.ports.length ?? 0,
    databases: preview?.databases.length ?? 0,
    dbSource,
    dbSourceName: typeof dbSource === 'object' ? worktreeName(dbSource.fromWorktree) : undefined,
    copyFiles: settings?.copyFiles.length ?? 0,
    cache: headCache ? { path: headCache.path, strategy: cacheOverrides[headCache.path] ?? headCache.strategy } : null,
    overrides: envRows.filter((row) => row.key.trim() !== '').length,
    skipSetup,
    runtime: runtime === 'follow' ? null : runtime
  })

  const path =
    settings && host.data
      ? renderWorktreePath(settings.worktrunk.worktreePath, {
          root: host.data.worktreeRoot,
          repo: project?.name ?? '',
          repoPath: project?.path ?? '',
          name: effectiveName || 'name',
          branch: branchName || 'branch'
        })
      : ''

  const submit = (autoStart: boolean): void => {
    if (!valid) return
    const input = buildCreateInput({
      name: effectiveName,
      branch,
      provision: configured,
      autoStart,
      allServices,
      selectedServices,
      env: envRows,
      dbSource,
      caches: cacheOverrides,
      cacheSource,
      skipSetup,
      runtime: runtime === 'follow' ? null : runtime
    })
    create.mutate(input, { onSuccess: (worktree) => navigate(`/worktrees/${worktree.id}`) })
  }

  if (!project) return <p className="p-6 text-sm text-muted-foreground">Project not found.</p>

  const autoStartDefault = settings?.defaults.autoStart ?? true

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8"
      onSubmit={(event) => {
        event.preventDefault()
        submit(autoStartDefault)
      }}
    >
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          New worktree <span className="font-mono text-muted-foreground">· {project.name}</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {configured
            ? 'Canopy creates the worktree, copies your local files, links caches, allocates ports, forks the databases and runs setup. The defaults below come from the project settings.'
            : 'Canopy checks the branch out into its own directory. Add a canopy.yaml to get ports, databases and services too.'}
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col gap-2">
            <SegmentedControl value={mode} onValueChange={(value) => setMode(value as BranchSpec['mode'])} aria-label="Branch mode">
              <SegmentedControlOption value="new">New branch</SegmentedControlOption>
              <SegmentedControlOption value="existing">Existing branch</SegmentedControlOption>
            </SegmentedControl>
            {mode === 'new' ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {prefix ? (
                    <Badge variant="secondary" className="shrink-0 font-mono text-[10px]" title="Branch prefix from the project's worktree defaults">
                      {prefix}
                    </Badge>
                  ) : null}
                  <Input aria-label="New branch name" placeholder="feat/my-feature" className="font-mono" value={newBranch} onChange={(event) => setNewBranch(event.target.value)} autoFocus />
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GitBranch className="size-3" /> from
                  </span>
                  <Select value={baseBranch} onValueChange={setBase}>
                    <SelectTrigger className="w-64 font-mono" aria-label="Base branch">
                      <SelectValue placeholder="Base branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {(branches.data?.branches ?? []).map((item) => (
                        <SelectItem key={item.name} value={item.name} className="font-mono">
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : (
              <SearchableListbox
                items={branches.data?.branches ?? []}
                getItemId={(item) => item.name}
                getItemKeywords={(item) => [item.name]}
                renderItem={(item) => <span className="font-mono text-sm">{item.name}</span>}
                value={existing}
                onValueChange={setExisting}
                listLabel="Branches"
                searchPlaceholder="Search branches"
                loading={branches.isPending}
                // The cap goes on the list, not the wrapper: the wrapper does not clip, so a
                // taller inner list would spill over the fields below.
                className="overflow-hidden rounded-lg border border-border"
                listClassName="max-h-60"
              />
            )}
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs text-muted-foreground">Worktree name</span>
            <Input aria-label="Worktree name" className="font-mono" value={effectiveName} onChange={(event) => setName(event.target.value)} />
            {effectiveName !== '' && !nameOk ? <span className="text-xs text-destructive">Lowercase letters, digits, dots, dashes and underscores only.</span> : null}
            {path ? <span className="truncate font-mono text-xs text-muted-foreground">{path}</span> : null}
          </label>

          {configured && summary.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-muted/40 p-3">
              {summary.map((label) => (
                <Badge key={label} variant="outline" className="text-[10px]">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}

          {configured ? (
            <Accordion type="multiple" className="w-full">
              <AccordionItem value="services">
                <AccordionTrigger>Services</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(allServices)}>
                        All
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setPicked([])}>
                        None
                      </Button>
                    </div>
                    {(preview?.services ?? []).map((service) => (
                      <label key={service.name} className="flex flex-wrap items-center gap-2 text-sm">
                        <Checkbox
                          checked={selectedServices.includes(service.name)}
                          aria-label={`Include ${service.name}`}
                          onChange={(event) =>
                            setPicked(event.currentTarget.checked ? [...selectedServices, service.name] : selectedServices.filter((entry) => entry !== service.name))
                          }
                        />
                        <span className="font-mono">{service.name}</span>
                        <Badge variant={service.runtime === 'host' ? 'outline' : 'secondary'} className="text-[10px]">
                          {service.runtime}
                        </Badge>
                        {service.autostart ? null : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            no autostart
                          </Badge>
                        )}
                        {service.description ? <span className="text-xs text-muted-foreground">{service.description}</span> : null}
                      </label>
                    ))}
                    {allServices.length === 0 ? <p className="text-xs text-muted-foreground">canopy.yaml declares no services.</p> : null}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="env">
                <AccordionTrigger>Environment</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">Inherited values are grayed; rows you add override them for this worktree only.</p>
                    {(preview?.env ?? []).map((row) => (
                      <div key={`yaml-${row.key}`} className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                        <span className="w-40 truncate">{row.key}</span>
                        <span className="flex-1 truncate">{row.secret ? '••••••' : row.value}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {row.source}
                        </Badge>
                      </div>
                    ))}
                    {(settings?.defaults.env ?? []).map((row) => (
                      <div key={`project-${row.key}`} className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                        <span className="w-40 truncate">{row.key}</span>
                        <span className="flex-1 truncate">{row.secret ? '••••••' : row.value}</span>
                        <Badge variant="outline" className="text-[10px]">
                          project
                        </Badge>
                      </div>
                    ))}
                    {envRows.map((row, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          aria-label={`Override key ${index + 1}`}
                          placeholder="KEY"
                          className="w-40 font-mono text-xs"
                          value={row.key}
                          onChange={(event) => setEnvRows(envRows.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))}
                        />
                        <Input
                          aria-label={`Override value ${index + 1}`}
                          placeholder="value"
                          className="flex-1 font-mono text-xs"
                          value={row.value}
                          onChange={(event) => setEnvRows(envRows.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))}
                        />
                        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Remove override ${index + 1}`} onClick={() => setEnvRows(envRows.filter((_, i) => i !== index))}>
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setEnvRows([...envRows, { key: '', value: '' }])}>
                      <Plus /> Add variable
                    </Button>
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="db">
                <AccordionTrigger>Database</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    {(preview?.databases ?? []).length === 0 ? (
                      <p className="text-xs text-muted-foreground">canopy.yaml declares no databases.</p>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-1.5">
                          {(preview?.databases ?? []).map((database) => (
                            <Badge key={database.name} variant="outline" className="font-mono text-[10px]">
                              {database.name} · {database.adapter} → {database.envKey}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">Where this worktree's forks start from.</p>
                        <Select
                          value={typeof dbSource === 'string' ? dbSource : dbSource.fromWorktree}
                          onValueChange={(value) => setDbChoice(value === 'template' || value === 'empty' ? value : { fromWorktree: value })}
                        >
                          <SelectTrigger className="w-full" aria-label="Database fork source">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="template">Seed template</SelectItem>
                            {siblings.map((worktree) => (
                              <SelectItem key={worktree.id} value={worktree.id}>
                                Fork from worktree {worktree.name}
                              </SelectItem>
                            ))}
                            <SelectItem value="empty">Empty databases</SelectItem>
                          </SelectContent>
                        </Select>
                      </>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="caches">
                <AccordionTrigger>Dependencies & caches</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    {cacheRules.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No cache rules — every dependency directory is rebuilt by setup.</p>
                    ) : (
                      cacheRules.map((rule) => (
                        <div key={rule.path} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-40 flex-1 truncate font-mono text-xs">{rule.path}</span>
                          <Select
                            value={cacheOverrides[rule.path] ?? CACHE_DEFAULT}
                            onValueChange={(value) =>
                              setCacheOverrides((current) => {
                                const next = { ...current }
                                if (value === CACHE_DEFAULT) delete next[rule.path]
                                else next[rule.path] = value as CacheStrategy
                                return next
                              })
                            }
                          >
                            <SelectTrigger className="w-44" aria-label={`Strategy for ${rule.path}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={CACHE_DEFAULT}>default ({rule.strategy})</SelectItem>
                              {CACHE_STRATEGIES.map((strategy) => (
                                <SelectItem key={strategy} value={strategy}>
                                  {strategy}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))
                    )}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <span className="text-xs text-muted-foreground">Copy from</span>
                      <Select
                        value={typeof cacheSource === 'string' ? 'primary' : cacheSource.fromWorktree}
                        onValueChange={(value) => setCacheSource(value === 'primary' ? 'primary' : { fromWorktree: value })}
                      >
                        <SelectTrigger className="w-56" aria-label="Cache source">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="primary">Primary checkout</SelectItem>
                          {siblings.map((worktree) => (
                            <SelectItem key={worktree.id} value={worktree.id}>
                              Worktree {worktree.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {settings?.caches.reinstallOnLockChange
                        ? 'Canopy reinstalls after the copy when this branch’s lockfile differs from the source’s.'
                        : 'Reinstall-on-lockfile-change is off for this project — a branch that changed its lockfile keeps the copied dependencies.'}
                    </p>
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="setup">
                <AccordionTrigger>Setup</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={skipSetup} aria-label="Skip setup commands" onChange={(event) => setSkipSetup(event.currentTarget.checked)} />
                      Skip setup commands
                    </label>
                    {(preview?.setup ?? []).length === 0 ? (
                      <p className="text-xs text-muted-foreground">canopy.yaml has no setup: steps.</p>
                    ) : (
                      <ol className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
                        {(preview?.setup ?? []).map((command, index) => (
                          <li key={`${command}-${index}`}>
                            {index + 1}. {command}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="runtime">
                <AccordionTrigger>Runtime</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    <SegmentedControl value={runtime} onValueChange={(value) => setRuntimeChoice(value as 'follow' | 'host' | 'docker')} aria-label="Runtime for this worktree">
                      <SegmentedControlOption value="follow">Follow canopy.yaml</SegmentedControlOption>
                      <SegmentedControlOption value="host">Force host</SegmentedControlOption>
                      <SegmentedControlOption value="docker">Force docker</SegmentedControlOption>
                    </SegmentedControl>
                    <p className="text-xs text-muted-foreground">Forcing a runtime applies to every service that supports it; compose services always follow their file.</p>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <TriangleAlert className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">
                {preview?.report.present ? 'This project’s canopy.yaml has errors, so nothing can be provisioned.' : 'No canopy.yaml yet — the worktree is created with git only.'}
              </span>
              <Button type="button" variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={() => navigate(`/projects/${projectId}/settings?tab=yaml`)}>
                Open canopy.yaml settings
              </Button>
            </div>
          )}

          <ErrorNote error={create.error} />
          <ErrorNote error={previewQuery.error} />

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => navigate('/')}>
              Cancel
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant={autoStartDefault ? 'outline' : 'default'} size="sm" disabled={!valid || create.isPending} onClick={() => submit(false)}>
                Create only
              </Button>
              <Button type="button" variant={autoStartDefault ? 'default' : 'outline'} size="sm" disabled={!valid || create.isPending} onClick={() => submit(true)}>
                {create.isPending ? 'Creating…' : 'Create & Start'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </form>
  )
}
