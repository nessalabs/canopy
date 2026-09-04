import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { Route, Router, Switch } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'

import { AppLayout } from './components/app-layout'
import { ExternalLinks } from './components/external-links'
import { TooltipProvider } from './components/ui/tooltip'
import { connectionStore } from './lib/connection-store'
import { ApiProvider } from './providers/api'
import { PlatformProvider, type DaemonConnection, type Platform } from './providers/platform'
import { CommandCenterScreen } from './screens/command-center-screen'
import { ConnectScreen } from './screens/connect-screen'
import { DocsScreen } from './screens/docs-screen'
import { ProjectSettingsScreen } from './screens/project-settings-screen'
import { WorktreeCreateScreen } from './screens/worktree-create-screen'
import { WorktreeDashboardScreen } from './screens/worktree-dashboard-screen'

export interface CanopyAppProps {
  platform: Platform
  /** Desktop passes the daemon connection it read from ~/.canopy; web asks the user. */
  initialConnection?: DaemonConnection
  openExternal?: (url: string) => void
}

const HINTS: Record<Platform, string> = {
  desktop: 'canopyd is not running yet: start it with `./dev.sh daemon` and reopen the app, or enter a remote daemon here.',
  web: 'Run `./dev.sh daemon`; it prints the token on start.'
}

function Routes(): React.JSX.Element {
  return (
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
  )
}

export function CanopyApp({ platform, initialConnection, openExternal }: CanopyAppProps): React.JSX.Element {
  const [connection, setConnection] = useState<DaemonConnection | null>(() => initialConnection ?? connectionStore.load())
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2000 } } }))

  const connect = (next: DaemonConnection): void => {
    connectionStore.save(next)
    setConnection(next)
  }

  return (
    <PlatformProvider value={{ platform, openExternal: openExternal ?? ((url) => window.open(url, '_blank', 'noopener')) }}>
      <ExternalLinks />
      <TooltipProvider>
        {connection ? (
          <ApiProvider connection={connection}>
            <QueryClientProvider client={queryClient}>
              <Router hook={useHashLocation}>
                <Routes />
              </Router>
            </QueryClientProvider>
          </ApiProvider>
        ) : (
          <ConnectScreen initial={initialConnection} hint={HINTS[platform]} onConnect={connect} />
        )}
      </TooltipProvider>
    </PlatformProvider>
  )
}
