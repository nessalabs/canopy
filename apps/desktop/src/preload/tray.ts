import { contextBridge, ipcRenderer } from 'electron'

import { TRAY_CHANNELS, type TrayAction, type TrayActionResult, type TraySnapshot } from '../shared/tray'

/**
 * The panel's whole world. It never talks to the daemon itself — the main process holds that
 * connection so the icon stays right while the panel is closed — so this bridge is a snapshot
 * feed plus the actions the panel can trigger.
 */
const canopyTray = {
  snapshot: (): Promise<TraySnapshot> => ipcRenderer.invoke(TRAY_CHANNELS.snapshot),
  /** Every change to the snapshot; returns its own unsubscribe. */
  onChange: (listener: (snapshot: TraySnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: TraySnapshot): void => listener(snapshot)
    ipcRenderer.on(TRAY_CHANNELS.changed, handler)
    return () => {
      ipcRenderer.off(TRAY_CHANNELS.changed, handler)
    }
  },
  /** Resolves with the daemon's message instead of rejecting, so the panel can show it inline. */
  run: (action: TrayAction): Promise<TrayActionResult> => ipcRenderer.invoke(TRAY_CHANNELS.action, action),
  openApp: (hash?: string): void => {
    void ipcRenderer.invoke(TRAY_CHANNELS.openApp, hash)
  },
  openExternal: (url: string): void => {
    void ipcRenderer.invoke(TRAY_CHANNELS.openExternal, url)
  },
  hide: (): void => ipcRenderer.send(TRAY_CHANNELS.hide),
  /** Asks the window to hug `height` pixels of content. */
  resize: (height: number): void => ipcRenderer.send(TRAY_CHANNELS.resize, height),
  retry: (): void => ipcRenderer.send(TRAY_CHANNELS.retry),
  quit: (): void => ipcRenderer.send(TRAY_CHANNELS.quit)
}

export type CanopyTrayBridge = typeof canopyTray

contextBridge.exposeInMainWorld('canopyTray', canopyTray)
