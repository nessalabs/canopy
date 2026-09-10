/**
 * The popover window under the menu-bar icon.
 *
 * It is created once and hidden rather than closed, so reopening is instant and the panel's
 * renderer keeps its scroll position. Everything it shows arrives over IPC from TrayState —
 * the window itself makes no network calls — and it hides on blur the way a menu extra does.
 */
import { join } from 'node:path'

import { BrowserWindow, screen, type Tray } from 'electron'
import { is } from '@electron-toolkit/utils'

const WIDTH = 392
/** Enough for the header and a line of status while the first snapshot loads. */
const INITIAL_HEIGHT = 220
const MIN_HEIGHT = 120
/** Past this the worktree list scrolls; a menu extra that runs off the screen is worse. */
const MAX_HEIGHT = 620
/** Breathing room between the menu bar and the panel, and at the screen edges. */
const GAP = 6
const MARGIN = 8

export class TrayPanel {
  private window: BrowserWindow | null = null
  private height = INITIAL_HEIGHT

  constructor(private readonly preload: string) {}

  isVisible(): boolean {
    return this.window?.isVisible() ?? false
  }

  /** The panel's webContents, for pushing snapshots; null before it is first opened. */
  contents(): Electron.WebContents | null {
    return this.window?.isDestroyed() ? null : (this.window?.webContents ?? null)
  }

  show(tray: Tray): void {
    const window = this.ensure()
    window.setBounds(this.boundsFor(tray))
    window.show()
    window.focus()
  }

  hide(): void {
    // `hide` alone leaves the app active on macOS with no window to return to; the previously
    // focused app should come back, exactly as when a menu closes.
    this.window?.hide()
  }

  /** Grows or shrinks the panel to the height its content reported, keeping it anchored. */
  resize(height: number, tray: Tray): void {
    const clamped = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)))
    if (clamped === this.height) return
    this.height = clamped
    if (this.window && !this.window.isDestroyed()) this.window.setBounds(this.boundsFor(tray))
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }

  /** Centred under the icon, pulled back inside the display it sits on. */
  private boundsFor(tray: Tray): Electron.Rectangle {
    const icon = tray.getBounds()
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(icon.x + icon.width / 2), y: Math.round(icon.y + icon.height / 2) })
    const wanted = Math.round(icon.x + icon.width / 2 - WIDTH / 2)
    return {
      x: Math.round(Math.min(Math.max(wanted, workArea.x + MARGIN), workArea.x + workArea.width - WIDTH - MARGIN)),
      y: Math.round(Math.max(icon.y + icon.height + GAP, workArea.y)),
      width: WIDTH,
      height: this.height
    }
  }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BrowserWindow({
      width: WIDTH,
      height: this.height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // The rounded, frosted surface is the page's; the window itself only supplies the blur.
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'popover',
      visualEffectState: 'active',
      hasShadow: true,
      webPreferences: {
        preload: this.preload,
        sandbox: false,
        // The panel is hidden most of the time but still renders live status when shown.
        backgroundThrottling: false
      }
    })

    // A menu extra floats above everything, including full-screen apps and other Spaces.
    window.setAlwaysOnTop(true, 'pop-up-menu')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    window.on('blur', () => {
      // Keeping it open while the devtools have focus is the only way to inspect it.
      if (window.webContents.isDevToolsOpened()) return
      window.hide()
    })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/tray.html`)
    else window.loadFile(join(__dirname, '../renderer/tray.html'))

    this.window = window
    return window
  }
}
