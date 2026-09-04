import { contextBridge, ipcRenderer } from 'electron'

export interface DaemonConnection {
  url: string
  token: string
}

const canopy = {
  /** Connection to the local canopyd read from ~/.canopy, or null when it has not been started yet. */
  getDaemonConnection: (): Promise<DaemonConnection | null> => ipcRenderer.invoke('daemon:connection'),
  openExternal: (url: string): void => {
    void ipcRenderer.invoke('shell:open-external', url)
  }
}

export type CanopyBridge = typeof canopy

contextBridge.exposeInMainWorld('canopy', canopy)
