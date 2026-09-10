import { contextBridge, ipcRenderer } from 'electron'

export interface DaemonConnection {
  url: string
  token: string
}

const canopy = {
  /** Host OS; the renderer leaves room for the traffic lights on macOS. */
  platform: process.platform,
  /** Connection to the local canopyd read from ~/.canopy, or null when it has not been started yet. */
  getDaemonConnection: (): Promise<DaemonConnection | null> => ipcRenderer.invoke('daemon:connection'),
  openExternal: (url: string): void => {
    void ipcRenderer.invoke('shell:open-external', url)
  },
  /** Hash routes pushed by the main process — the menu-bar panel opening a worktree. */
  onNavigate: (listener: (hash: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, hash: string): void => listener(hash)
    ipcRenderer.on('canopy:navigate', handler)
    return () => {
      ipcRenderer.off('canopy:navigate', handler)
    }
  }
}

export type CanopyBridge = typeof canopy

contextBridge.exposeInMainWorld('canopy', canopy)
