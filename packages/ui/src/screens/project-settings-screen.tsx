/** Project settings: a left nav over one tab per concern. This machine's preferences have their own screen. */
import { useEffect, useState } from 'react'
import { Boxes, Eraser, FileCode, Files, FolderGit2, GitMerge, Settings, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
import { useLocation } from 'wouter'

import type { Project } from '@canopy/shared'

import { CachesTab } from '@/components/settings/caches-tab'
import { CleanupTab } from '@/components/settings/cleanup-tab'
import { TrashTab } from '@/components/settings/trash-tab'
import { DangerTab } from '@/components/settings/danger-tab'
import { DefaultsTab } from '@/components/settings/defaults-tab'
import { DraftsTab } from '@/components/settings/drafts-tab'
import { GeneralTab } from '@/components/settings/general-tab'
import { NavButton } from '@/components/settings/settings-chrome'
import { useDraftSettings } from '@/components/settings/use-draft-settings'
import { WorktreeTab } from '@/components/settings/worktree-tab'
import { YamlTab } from '@/components/settings/yaml-tab'
import { useProjects } from '@/lib/api-hooks'
import { SETTINGS_TAB_LABEL, parseSettingsTab, settingsHref, type SettingsTabId } from '@/lib/settings-ui'

type TabIcon = React.ComponentType<{ className?: string }>

const PROJECT_TABS: Array<{ id: SettingsTabId; icon: TabIcon }> = [
  { id: 'general', icon: Settings },
  { id: 'worktree', icon: GitMerge },
  { id: 'yaml', icon: FileCode },
  { id: 'caches', icon: Files },
  { id: 'defaults', icon: Boxes },
  { id: 'drafts', icon: Sparkles },
  // Cleanup is the policy; Trash is the bin those policies fill, so the bin gets the bin icon.
  { id: 'cleanup', icon: Eraser },
  { id: 'trash', icon: Trash2 },
  { id: 'danger', icon: TriangleAlert }
]

/** Mounted under a key of the project id, so every project gets a clean draft and tab. */
function ProjectSettings({ project }: { project: Project }): React.JSX.Element {
  const draft = useDraftSettings(project.id)
  const [, navigate] = useLocation()
  const [tab, setTab] = useState<SettingsTabId>(() => parseSettingsTab(window.location.hash, window.location.search))

  // App preferences used to be a tab here; an old deep link still lands on the new screen.
  useEffect(() => {
    if (tab === 'app') navigate('/settings', { replace: true })
  }, [tab, navigate])

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
        </nav>

        <div className="min-w-0 flex-1">
          {tab === 'general' ? <GeneralTab key={`${project.name}:${project.defaultBase}`} project={project} draft={draft} /> : null}
          {tab === 'worktree' ? <WorktreeTab project={project} draft={draft} /> : null}
          {tab === 'yaml' ? <YamlTab project={project} /> : null}
          {tab === 'caches' ? <CachesTab project={project} draft={draft} /> : null}
          {tab === 'defaults' ? <DefaultsTab draft={draft} /> : null}
          {tab === 'drafts' ? <DraftsTab draft={draft} /> : null}
          {tab === 'cleanup' ? <CleanupTab draft={draft} /> : null}
          {tab === 'trash' ? <TrashTab projectId={project.id} /> : null}
          {tab === 'danger' ? <DangerTab project={project} /> : null}
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
