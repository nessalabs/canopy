/**
 * The menu-bar extra: a template icon that says how much is running, a popover panel, and the
 * IPC the panel acts through. The daemon connection lives in TrayState, not in the panel, so
 * the icon is right even when no window has ever been opened.
 */
import { app, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent } from 'electron'

import { isLive, type ServiceAction, type Worktree } from '@canopy/shared'

import { TRAY_CHANNELS, type TrayAction, type TrayActionResult, type TraySnapshot } from '../../shared/tray'
import { resource } from '../resources'
import { TrayPanel } from './panel'
import { TrayState } from './state'

export interface TrayOptions {
  /** Brings the app window forward, optionally on a hash route (`#/worktrees/<id>`). */
  showMainWindow: (hash?: string) => void
  /** Preload for the panel window. */
  preload: string
}

export interface TrayController {
  dispose: () => void
}

const live = (worktrees: Worktree[]): Worktree[] => worktrees.filter((worktree) => isLive(worktree.environment.state))

/**
 * What rides next to the icon. The count of live environments is the one number worth carrying
 * in the menu bar; a trailing `!` marks that at least one of them needs attention, which is the
 * only thing urgent enough to interrupt a glance.
 */
function iconTitle(snapshot: TraySnapshot): string {
  if (snapshot.status !== 'connected') return ''
  const running = live(snapshot.worktrees)
  if (running.length === 0) return ''
  const failing = running.some(
    (worktree) =>
      worktree.environment.state === 'error' ||
      worktree.environment.state === 'degraded' ||
      worktree.environment.services.some((service) => !service.excluded && ['unhealthy', 'exited', 'failed'].includes(service.status))
  )
  return failing ? `${running.length}!` : String(running.length)
}

function tooltip(snapshot: TraySnapshot): string {
  if (snapshot.status === 'offline') return `Canopy — ${snapshot.error ?? 'canopyd is not running'}`
  if (snapshot.status === 'connecting') return 'Canopy — connecting…'
  const running = live(snapshot.worktrees)
  if (running.length === 0) return 'Canopy — nothing running'
  const services = running.reduce((total, worktree) => total + worktree.environment.services.filter((service) => !service.excluded && service.status === 'healthy').length, 0)
  return `Canopy — ${running.length} environment${running.length === 1 ? '' : 's'}, ${services} service${services === 1 ? '' : 's'} running`
}

export function installTray({ showMainWindow, preload }: TrayOptions): TrayController {
  const icon = nativeImage.createFromPath(resource('canopyTemplate.png'))
  // Template images are recoloured by macOS for the light, dark and highlighted menu bar.
  icon.setTemplateImage(true)

  const tray = new Tray(icon)
  const state = new TrayState()
  const panel = new TrayPanel(preload)

  const runAction = async (action: TrayAction): Promise<TrayActionResult> => {
    try {
      const api = state.api()
      switch (action.kind) {
        case 'start':
          await api.startWorktree(action.worktreeId)
          break
        case 'stop':
          await api.stopWorktree(action.worktreeId)
          break
        case 'restart':
          await api.restartWorktree(action.worktreeId)
          break
        case 'provision':
          await api.provisionWorktree(action.worktreeId, { autoStart: true })
          break
        case 'service':
          await api.serviceAction(action.worktreeId, action.service, action.action satisfies ServiceAction)
          break
        case 'open':
          await api.openWorktree(action.worktreeId, { target: action.target })
          break
        case 'stop-all':
          await api.stopAllWorktrees(action.projectId)
          break
      }
      await state.refresh()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Only the panel may drive the tray; anything else on these channels is ignored. */
  const fromPanel = (event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => event.sender === panel.contents()

  ipcMain.handle(TRAY_CHANNELS.snapshot, () => state.snapshot())
  ipcMain.handle(TRAY_CHANNELS.action, async (event, action: TrayAction) => (fromPanel(event) ? runAction(action) : ({ ok: false, error: 'not the tray panel' } satisfies TrayActionResult)))
  ipcMain.handle(TRAY_CHANNELS.openApp, (event, hash: string | undefined) => {
    if (!fromPanel(event)) return
    panel.hide()
    showMainWindow(hash)
  })
  ipcMain.handle(TRAY_CHANNELS.openExternal, async (event, url: string) => {
    if (!fromPanel(event)) return
    panel.hide()
    await shell.openExternal(url)
  })
  ipcMain.on(TRAY_CHANNELS.hide, (event) => {
    if (fromPanel(event)) panel.hide()
  })
  ipcMain.on(TRAY_CHANNELS.resize, (event, height: number) => {
    if (fromPanel(event) && Number.isFinite(height)) panel.resize(height, tray)
  })
  ipcMain.on(TRAY_CHANNELS.retry, (event) => {
    if (fromPanel(event)) state.retryNow()
  })
  ipcMain.on(TRAY_CHANNELS.quit, (event) => {
    if (fromPanel(event)) app.quit()
  })

  const unsubscribe = state.subscribe((snapshot) => {
    tray.setTitle(iconTitle(snapshot))
    tray.setToolTip(tooltip(snapshot))
    // A hidden panel re-rendering on every host sample is pure waste; `open` catches it up.
    if (panel.isVisible()) panel.contents()?.send(TRAY_CHANNELS.changed, snapshot)
  })
  tray.setToolTip(tooltip(state.snapshot()))

  const open = (): void => {
    // Opening is also the moment to stop waiting: someone looking at the panel wants it live now.
    state.retryNow()
    panel.show(tray)
    panel.contents()?.send(TRAY_CHANNELS.changed, state.snapshot())
  }

  tray.on('click', () => (panel.isVisible() ? panel.hide() : open()))
  // A native menu stays reachable if the panel ever fails to render.
  tray.on('right-click', () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Canopy', click: () => showMainWindow() },
        { type: 'separator' },
        { label: 'Quit Canopy', click: () => app.quit() }
      ])
    )
  })

  state.start()

  return {
    dispose: () => {
      unsubscribe()
      state.dispose()
      panel.dispose()
      tray.destroy()
      for (const channel of [TRAY_CHANNELS.snapshot, TRAY_CHANNELS.action, TRAY_CHANNELS.openApp, TRAY_CHANNELS.openExternal]) ipcMain.removeHandler(channel)
      for (const channel of [TRAY_CHANNELS.hide, TRAY_CHANNELS.resize, TRAY_CHANNELS.retry, TRAY_CHANNELS.quit]) ipcMain.removeAllListeners(channel)
    }
  }
}
