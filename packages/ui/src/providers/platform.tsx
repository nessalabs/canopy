import { createContext, useContext } from 'react'

export type Platform = 'web' | 'desktop'

export interface DaemonConnection {
  url: string
  token: string
}

export interface PlatformInfo {
  platform: Platform
  /**
   * The native window paints its controls (macOS traffic lights) over the top-left of the
   * page, so the shell leaves that strip empty and makes it draggable.
   */
  titleBarInset: boolean
  /** Opens a URL outside the app (system browser). Desktop overrides with shell.openExternal. */
  openExternal: (url: string) => void
}

const PlatformContext = createContext<PlatformInfo>({
  platform: 'web',
  titleBarInset: false,
  openExternal: (url) => window.open(url, '_blank', 'noopener')
})

export const PlatformProvider = PlatformContext.Provider

export function usePlatform(): PlatformInfo {
  return useContext(PlatformContext)
}
