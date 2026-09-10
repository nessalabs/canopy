/** Project settings: a left nav over one tab per concern, plus this machine's app preferences. */
import { useEffect, useState } from 'react'
import { Boxes, FileCode, Files, FolderGit2, GitMerge, Monitor, Settings, Trash2, TriangleAlert } from 'lucide-react'

import type { Project } from '@canopy/shared'

import { AppTab } from '@/components/settings/app-tab'
import { CachesTab } from '@/components/settings/caches-tab'
import { CleanupTab } from '@/components/settings/cleanup-tab'
import { DangerTab } from '@/components/settings/danger-tab'
import { DefaultsTab } from '@/components/settings/defaults-tab'
import { GeneralTab } from '@/components/settings/general-tab'
import { useDraftSettings } from '@/components/settings/use-draft-settings'
import { WorktrunkTab } from '@/components/settings/worktrunk-tab'
import { YamlTab } from '@/components/settings/yaml-tab'
import { Button } from '@/components/ui/button'
import { useProjects } from '@/lib/api-hooks'
import { SETTINGS_TAB_LABEL, parseSettingsTab, settingsHref, type SettingsTabId } from '@/lib/settings-ui'
import { cn } from '@/lib/utils'

type TabIcon = React.ComponentType<{ className?: string }>

const PROJECT_TABS: Array<{ id: SettingsTabId; icon: TabIcon }> = [
  { id: 'general', icon: Settings },
  { id: 'worktrunk', icon: GitMerge },
  { id: 'yaml', icon: FileCode },
  { id: 'caches', icon: Files },
  { id: 'defaults', icon: Boxes },
  { id: 'cleanup', icon: Trash2 },
  { id: 'danger', icon: TriangleAlert }
]

const MACHINE_TABS: Array<{ id: SettingsTabId; icon: TabIcon }> = [{ id: 'app', icon: Monitor }]

function NavButton({ active, danger, icon: Icon, label, onClick }: { active: boolean; danger?: boolean; icon: TabIcon; label: string; onClick: () => void }): React.JSX.Element {
  return (
    <Button variant={active ? 'secondary' : 'ghost'} size="sm" className={cn('justify-start', danger && 'text-destructive')} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon className="size-3.5" />
      {label}
    </Button>
  )
}

/** Mounted under a key of the project id, so every project gets a clean draft and tab. */
function ProjectSettings({ project }: { project: Project }): React.JSX.Element {
  const draft = useDraftSettings(project.id)
  const [tab, setTab] = useState<SettingsTabId>(() => parseSettingsTab(window.location.hash, window.location.search))

  // Deep links land here through the hash router; follow them when the URL changes under us.
  useEffect(() => {
    const sync = (): void => setTab(parseSettingsTab(window.location.hash, window.location.search))
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  const select = (next: SettingsTabId): void => {
    setTab(next)
    window.history.replaceState(null, '', settingsHref(window.location.href, next))
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <FolderGit2 className="size-5 text-primary" />
          <span className="font-mono">{project.name}</span>
          <span className="text-muted-foreground">settings</span>
        </h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{project.path}</p>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row">
        <nav className="flex shrink-0 flex-row gap-1 overflow-x-auto sm:w-52 sm:flex-col" aria-label="Settings sections">
          <p className="hidden px-3 pb-1 text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase sm:block">project</p>
          {PROJECT_TABS.map((entry) => (
            <NavButton key={entry.id} active={tab === entry.id} danger={entry.id === 'danger'} icon={entry.icon} label={SETTINGS_TAB_LABEL[entry.id]} onClick={() => select(entry.id)} />
          ))}
          <p className="hidden px-3 pt-4 pb-1 text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase sm:block">this machine</p>
          {MACHINE_TABS.map((entry) => (
            <NavButton key={entry.id} active={tab === entry.id} icon={entry.icon} label={SETTINGS_TAB_LABEL[entry.id]} onClick={() => select(entry.id)} />
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {tab === 'general' ? <GeneralTab key={`${project.name}:${project.defaultBase}`} project={project} draft={draft} /> : null}
          {tab === 'worktrunk' ? <WorktrunkTab project={project} draft={draft} /> : null}
          {tab === 'yaml' ? <YamlTab project={project} /> : null}
          {tab === 'caches' ? <CachesTab project={project} draft={draft} /> : null}
          {tab === 'defaults' ? <DefaultsTab draft={draft} /> : null}
          {tab === 'cleanup' ? <CleanupTab draft={draft} /> : null}
          {tab === 'danger' ? <DangerTab project={project} /> : null}
          {tab === 'app' ? <AppTab /> : null}
        </div>
      </div>
    </div>
  )
}

/** Settings for one project, deep-linkable per tab with `?tab=`. */
export function ProjectSettingsScreen({ projectId }: { projectId: string }): React.JSX.Element {
  const projects = useProjects()
  const project = projects.data?.find((candidate) => candidate.id === projectId)
  if (!project) return <p className="p-6 text-sm text-muted-foreground">{projects.isPending ? 'Loading…' : 'Project not found.'}</p>
  return <ProjectSettings key={project.id} project={project} />
}
