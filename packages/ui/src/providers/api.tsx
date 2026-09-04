import { createContext, useContext, useMemo } from 'react'

import { createClient, type CanopyClient } from '@canopy/shared'

import type { DaemonConnection } from './platform'

const ApiContext = createContext<CanopyClient | null>(null)

export function ApiProvider({ connection, children }: { connection: DaemonConnection; children: React.ReactNode }): React.JSX.Element {
  const client = useMemo(() => createClient({ baseUrl: connection.url, token: connection.token }), [connection.url, connection.token])
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
}

export function useApi(): CanopyClient {
  const client = useContext(ApiContext)
  if (!client) throw new Error('useApi must be used inside <ApiProvider>')
  return client
}
