import { useState } from 'react'
import { Database, KeyRound, ListChecks, ScrollText, Server } from 'lucide-react'

import type { Worktree } from '@canopy/shared'

import { PanelShell, type PanelDef } from '@/components/panel-shell'
import { PaneSplitDirection, createAppShellLayout, setSplitWeights, splitPane, type AppShellLayout } from '@/lib/app-shell-layout'

import { DatabasesPanel } from './databases-panel'
import { LogsPanel } from './logs-panel'
import { PipelinePanel } from './pipeline-panel'
import { ServicesPanel } from './services-panel'
import { VarsPanel } from './vars-panel'

/** Default arrangement: logs-first left column with services and the pipeline under it, vars + databases right. */
export function buildEnvironmentLayout(): AppShellLayout {
  let layout = createAppShellLayout({ initialPaneId: 'pane-logs', views: ['logs'], openDocks: [] })
  layout = splitPane(layout, { paneId: 'pane-logs', direction: PaneSplitDirection.Right, newPaneId: 'pane-vars', views: ['vars'] })
  layout = splitPane(layout, { paneId: 'pane-logs', direction: PaneSplitDirection.Down, newPaneId: 'pane-services', views: ['services'] })
  layout = splitPane(layout, { paneId: 'pane-services', direction: PaneSplitDirection.Down, newPaneId: 'pane-pipeline', views: ['pipeline'] })
  layout = splitPane(layout, { paneId: 'pane-vars', direction: PaneSplitDirection.Down, newPaneId: 'pane-databases', views: ['databases'] })
  layout = setSplitWeights(layout, { splitId: 'split:pane-vars', weights: [0.63, 0.37] })
  layout = setSplitWeights(layout, { splitId: 'split:pane-services', weights: [0.42, 0.27, 0.31] })
  layout = setSplitWeights(layout, { splitId: 'split:pane-databases', weights: [0.4, 0.6] })
  return layout
}

/**
 * Everything Canopy runs for one worktree, as rearrangeable panels: the provisioning
 * pipeline, services, database forks, live logs and the resolved env. The selected log
 * stream lives here so the Services panel's "Logs" buttons drive the Logs panel.
 */
export function EnvironmentTab({ worktree, resetToken }: { worktree: Worktree; resetToken: number }): React.JSX.Element {
  const [logService, setLogService] = useState('')

  const panels: PanelDef[] = [
    { id: 'pipeline', title: 'Provisioning pipeline', icon: ListChecks, render: () => <PipelinePanel worktree={worktree} /> },
    { id: 'services', title: 'Services', icon: Server, render: () => <ServicesPanel worktree={worktree} onShowLogs={setLogService} /> },
    { id: 'databases', title: 'Databases', icon: Database, render: () => <DatabasesPanel worktree={worktree} /> },
    { id: 'logs', title: 'Logs', icon: ScrollText, render: () => <LogsPanel worktree={worktree} service={logService} onServiceChange={setLogService} /> },
    { id: 'vars', title: 'Branch vars', icon: KeyRound, render: () => <VarsPanel worktree={worktree} /> }
  ]

  return (
    <PanelShell
      storageKey={`canopy-env-layout-v3:${worktree.id}`}
      buildDefaultLayout={buildEnvironmentLayout}
      panels={panels}
      resetToken={resetToken}
      className="h-full min-h-[480px]"
    />
  )
}
