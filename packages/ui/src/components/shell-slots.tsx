import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * The regions of the app's chrome a screen fills from its own tree:
 *
 * - `view`    — top bar, left: the screen's own tabs (Git's Changes | History | …)
 * - `section` — top bar, centre: the worktree's section switcher
 * - `tools`   — top bar, right: controls for what is on screen (diff layout, panel chips)
 * - `actions` — top bar, far right: the one primary action and its overflow menu
 * - `status`  — status bar, left: the worktree's branch, sync and changes
 * - `statusEnd` — status bar, right: per-worktree popovers (logs, agent)
 *
 * Rendering through a slot costs the screen no vertical space while its controls still live in
 * its own tree, so their state, queries and dialogs stay where they are.
 */
export type ShellSlotName = 'view' | 'section' | 'tools' | 'actions' | 'status' | 'statusEnd'

interface Mounts {
  mounts: Partial<Record<ShellSlotName, HTMLElement | null>>
  setMount: (name: ShellSlotName, element: HTMLElement | null) => void
}

const ShellSlotContext = createContext<Mounts>({ mounts: {}, setMount: () => undefined })

export function ShellSlotProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [mounts, setMounts] = useState<Mounts['mounts']>({})
  const setMount = useCallback((name: ShellSlotName, element: HTMLElement | null) => setMounts((current) => (current[name] === element ? current : { ...current, [name]: element })), [])
  const value = useMemo(() => ({ mounts, setMount }), [mounts, setMount])
  return <ShellSlotContext.Provider value={value}>{children}</ShellSlotContext.Provider>
}

/** Where one slot's content lands in the chrome; empty on screens that pass nothing. */
export function ShellSlotTarget({ name, className }: { name: ShellSlotName; className?: string }): React.JSX.Element {
  const { setMount } = useContext(ShellSlotContext)
  const ref = useCallback((element: HTMLElement | null) => setMount(name, element), [name, setMount])
  return <div ref={ref} data-shell-slot={name} className={className} />
}

/** Renders its children into a slot of the chrome instead of in place. */
export function ShellSlot({ name, children }: { name: ShellSlotName; children: React.ReactNode }): React.JSX.Element | null {
  const mount = useContext(ShellSlotContext).mounts[name]
  return mount ? createPortal(children, mount) : null
}
