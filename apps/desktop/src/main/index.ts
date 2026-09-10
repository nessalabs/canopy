import { join } from 'node:path'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { readDaemonConnection } from './daemon-connection'
import { installTray, type TrayController } from './tray'

/** The app window. Tracked by hand: on macOS the tray panel is also a BrowserWindow. */
let mainWindow: BrowserWindow | null = null

/** The preload every app window loads — the pop-out windows need the same bridge. */
const appPreload = (): string => join(__dirname, '../preload/index.mjs')

/** Whether a URL is this app again: the same document, on one of its own hash routes. */
function isAppUrl(from: BrowserWindow, url: string): boolean {
  try {
    const target = new URL(url)
    const current = new URL(from.webContents.getURL())
    // file:// URLs all share the origin "null", so the document itself is what separates the
    // app's own routes from anything else that might be opened with one.
    return target.origin === current.origin && target.pathname === current.pathname
  } catch {
    return false
  }
}

/**
 * Where links and `window.open` go. The app opening one of its own routes is a pop-out — a
 * file or a diagram pulled out to sit beside the window it came from — and gets a real window
 * with the same bridge; every other URL is a link, and belongs to the system browser.
 */
function routeWindowLinks(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(window, url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1100,
        height: 850,
        minWidth: 420,
        minHeight: 320,
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        // A normal frame, unlike the main window: a pop-out has no in-app header to read as a
        // title bar, and its native one names the file it is showing.
        webPreferences: { preload: appPreload(), sandbox: false }
      }
    }
  })

  // The window only ever shows the app; navigation anywhere else belongs to the system browser.
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === new URL(window.webContents.getURL()).origin) return
    event.preventDefault()
    shell.openExternal(url)
  })

  // Pop-outs can pop out in turn — a diagram opened from a file that is itself in a window.
  window.webContents.on('did-create-window', (child) => routeWindowLinks(child))
}

/** Where the renderer's pop-out windows load from: this same app, on the hash route it asked for. */
function loadAppRoute(window: BrowserWindow, hash: string): void {
  const route = hash.startsWith('#') ? hash.slice(1) : hash
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.hash = route
    void window.loadURL(url.href)
    return
  }
  void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
}

/**
 * A window holding one file or one diagram, opened from the app so it can be read beside the
 * window it came from. It wears a normal frame — a pop-out has no in-app header to read as a
 * title bar, and the native one names what it is showing.
 */
function openPopOutWindow(hash: string): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 850,
    minWidth: 420,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: appPreload(),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => window.show())
  routeWindowLinks(window)
  loadAppRoute(window, hash)
}

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
      preload: appPreload(),
      sandbox: false
    }
  })

  const window = mainWindow

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  routeWindowLinks(window)

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
  ipcMain.handle('window:open', (_event, hash: string) => openPopOutWindow(hash))

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
