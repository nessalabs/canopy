import type { CanopyBridge } from './index'
import type { CanopyTrayBridge } from './tray'

declare global {
  interface Window {
    canopy: CanopyBridge
    /** Only the menu-bar panel window gets this bridge. */
    canopyTray: CanopyTrayBridge
  }
}
