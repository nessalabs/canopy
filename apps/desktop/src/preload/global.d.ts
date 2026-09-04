import type { CanopyBridge } from './index'

declare global {
  interface Window {
    canopy: CanopyBridge
  }
}
