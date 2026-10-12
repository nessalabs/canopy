import { createContext, useContext } from 'react'

/** Where the terminal docks: along the bottom, as in VS Code, or in the right-hand panel. */
export type TerminalDock = 'bottom' | 'right'

export interface TerminalDockControls {
  open: boolean
  dock: TerminalDock
  toggle: () => void
  moveTo: (dock: TerminalDock) => void
}

const TerminalDockContext = createContext<TerminalDockControls | null>(null)

export const TerminalDockProvider = TerminalDockContext.Provider

/** The app's terminal dock, for whatever opens or moves it — the status bar, the panel itself. */
export function useTerminalDock(): TerminalDockControls {
  const controls = useContext(TerminalDockContext)
  if (!controls) throw new Error('useTerminalDock needs a TerminalDockProvider')
  return controls
}
