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
  /**
   * Opens another window of this app on one of its `/window/…` hash routes — a file or a
   * diagram, pulled out to sit beside what it came from. On desktop the main process turns the
   * same call into a real window; in a browser it is a popup.
   */
  openWindow: (hash: string) => void
}

/** Both hosts open pop-outs the same way; Electron's main process shapes the window it makes. */
export function openAppWindow(hash: string): void {
  window.open(`${window.location.pathname}${window.location.search}#${hash}`, '_blank', 'popup=yes,width=1100,height=850')
}

const PlatformContext = createContext<PlatformInfo>({
  platform: 'web',
  titleBarInset: false,
  openExternal: (url) => window.open(url, '_blank', 'noopener'),
  openWindow: openAppWindow
})

export const PlatformProvider = PlatformContext.Provider

export function usePlatform(): PlatformInfo {
  return useContext(PlatformContext)
}
