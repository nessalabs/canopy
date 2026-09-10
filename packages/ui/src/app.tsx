import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { Route, Router, Switch } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'

import { AppLayout } from './components/app-layout'
import { ExternalLinks } from './components/external-links'
import { DiagramWindowProvider } from './components/ui/mermaid-diagram'
import { TooltipProvider } from './components/ui/tooltip'
import { connectionStore } from './lib/connection-store'
import { CanopyEventsProvider } from './lib/events-provider'
import { diagramWindowHash, fileWindowParams, stashDiagram } from './lib/pop-out'
import { ApiProvider } from './providers/api'
import { PlatformProvider, openAppWindow, type DaemonConnection, type Platform } from './providers/platform'
import { CommandCenterScreen } from './screens/command-center-screen'
import { ConnectScreen } from './screens/connect-screen'
import { DiagramWindowScreen } from './screens/diagram-window-screen'
import { DocsScreen } from './screens/docs-screen'
import { FileWindowScreen } from './screens/file-window-screen'
import { ProjectSettingsScreen } from './screens/project-settings-screen'
import { WorktreeCreateScreen } from './screens/worktree-create-screen'
import { WorktreeDashboardScreen } from './screens/worktree-dashboard-screen'

export interface CanopyAppProps {
  platform: Platform
  /** Desktop on macOS: the traffic lights sit over the page, so the shell reserves a strip for them. */
  titleBarInset?: boolean
  /** Desktop passes the daemon connection it read from ~/.canopy; web asks the user. */
  initialConnection?: DaemonConnection
  openExternal?: (url: string) => void
  /** Desktop may shape its own pop-out windows; both hosts default to `window.open`. */
  openWindow?: (hash: string) => void
}

const HINTS: Record<Platform, string> = {
  desktop: 'canopyd is not running yet: start it with `./dev.sh daemon` and reopen the app, or enter a remote daemon here.',
  web: 'Run `./dev.sh daemon`; it prints the token on start.'
}

/**
 * The app's screens. `/window/…` routes are what a pop-out window opens on: one file or one
 * diagram, and no app chrome around it — the window itself is the frame, and its only job is
 * to sit beside the window it was opened from.
 */
function Routes(): React.JSX.Element {
  return (
    <Switch>
      <Route path="/window/file/:worktreeId/:rev/*">
        {(params) => <FileWindowScreen {...fileWindowParams(params.worktreeId, params.rev, params['*'] ?? '')} />}
      </Route>
      <Route path="/window/diagram/:key">{(params) => <DiagramWindowScreen id={params.key} />}</Route>
      <Route>
        <AppLayout>
          <Switch>
            <Route path="/" component={CommandCenterScreen} />
            <Route path="/worktrees/:id">{(params) => <WorktreeDashboardScreen id={params.id} />}</Route>
            <Route path="/projects/:id/new">{(params) => <WorktreeCreateScreen projectId={params.id} />}</Route>
            <Route path="/projects/:id/settings">{(params) => <ProjectSettingsScreen projectId={params.id} />}</Route>
            <Route path="/docs" component={DocsScreen} />
            <Route component={CommandCenterScreen} />
          </Switch>
        </AppLayout>
      </Route>
    </Switch>
  )
}

export function CanopyApp({ platform, titleBarInset = false, initialConnection, openExternal, openWindow = openAppWindow }: CanopyAppProps): React.JSX.Element {
  const [connection, setConnection] = useState<DaemonConnection | null>(() => initialConnection ?? connectionStore.load())
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2000 } } }))

  // AppLayout reserves the traffic-light strip in its own chrome, but surfaces that cover the
  // whole window — the fullscreen diagram viewer — sit outside that layout. Publishing the
  // strip's height on the root element lets them clear it too: the native title bar keeps the
  // mouse events over it, so a control drawn inside the strip is only half clickable.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--nessa-title-bar-inset', titleBarInset ? '32px' : '0px')
    return () => {
      root.style.removeProperty('--nessa-title-bar-inset')
    }
  }, [titleBarInset])

  // A diagram cannot be handed to another window as a prop, so its source is stashed under a
  // key and the window opens on that key.
  const openDiagramWindow = useCallback((chart: string) => openWindow(diagramWindowHash(stashDiagram(chart))), [openWindow])

  const connect = (next: DaemonConnection): void => {
    connectionStore.save(next)
    setConnection(next)
  }

  return (
    <PlatformProvider value={{ platform, titleBarInset, openExternal: openExternal ?? ((url) => window.open(url, '_blank', 'noopener')), openWindow }}>
      <ExternalLinks />
      <TooltipProvider>
        {connection ? (
          <ApiProvider connection={connection}>
            <QueryClientProvider client={queryClient}>
              <CanopyEventsProvider>
                <DiagramWindowProvider open={openDiagramWindow}>
                  <Router hook={useHashLocation}>
                    <Routes />
                  </Router>
                </DiagramWindowProvider>
              </CanopyEventsProvider>
            </QueryClientProvider>
          </ApiProvider>
        ) : (
          <ConnectScreen initial={initialConnection} hint={HINTS[platform]} onConnect={connect} />
        )}
      </TooltipProvider>
    </PlatformProvider>
  )
}
