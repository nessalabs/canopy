import { createContext, useContext } from 'react'

export type Platform = 'web' | 'desktop'

export interface DaemonConnection {
  url: string
  token: string
}

export interface PlatformInfo {
  platform: Platform
  /** Opens a URL outside the app (system browser). Desktop overrides with shell.openExternal. */
  openExternal: (url: string) => void
}

const PlatformContext = createContext<PlatformInfo>({
  platform: 'web',
  openExternal: (url) => window.open(url, '_blank', 'noopener')
})

export const PlatformProvider = PlatformContext.Provider

export function usePlatform(): PlatformInfo {
  return useContext(PlatformContext)
}
