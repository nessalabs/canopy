import { join } from 'node:path'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { readDaemonConnection } from './daemon-connection'
import { installTray, type TrayController } from './tray'

/** The app window. Tracked by hand: on macOS the tray panel is also a BrowserWindow. */
let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Frameless-ish chrome so the in-app header reads as the title bar. The traffic
    // lights are pinned so they sit centred in the 32px strip AppLayout reserves
    // above the sidebar header on macOS (see titleBarInset).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  const window = mainWindow

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // The window only ever shows the app; navigation anywhere else belongs to the system browser.
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === new URL(window.webContents.getURL()).origin) return
    event.preventDefault()
    shell.openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** Raises the app window — recreating it if it was closed — optionally on a hash route. */
function showMainWindow(hash?: string): void {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
  if (hash === undefined) return
  // The renderer routes on the hash; sending it after `did-finish-load` covers a cold start.
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', () => window.webContents.send('canopy:navigate', hash))
  else window.webContents.send('canopy:navigate', hash)
}

let tray: TrayController | null = null

app.whenReady().then(() => {
  electronApp.setAppUserModelId('ai.nessalabs.canopy')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('daemon:connection', () => readDaemonConnection())
  ipcMain.handle('shell:open-external', (_event, url: string) => shell.openExternal(url))

  createWindow()
  tray = installTray({ showMainWindow, preload: join(__dirname, '../preload/tray.mjs') })

  // Clicking the dock icon reopens the window the tray let the user close.
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

// The menu-bar extra holds an SSE stream open; dropping it lets the process exit promptly.
app.on('before-quit', () => {
  tray?.dispose()
  tray = null
})

app.on('window-all-closed', () => {
  // macOS keeps the app in the menu bar after the window closes; elsewhere there is no tray to
  // return from, so closing the window quits.
  if (process.platform !== 'darwin') app.quit()
})
