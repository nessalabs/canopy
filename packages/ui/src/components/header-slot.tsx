import { createContext, useContext, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * The top bar owns a region that the active screen fills. A screen renders its title row
 * through <HeaderSlot>, so the row costs no vertical space in the scrolling body while it
 * still lives in the screen's own tree (its dialogs, queries and state stay put).
 */
const HeaderSlotContext = createContext<{ mount: HTMLElement | null; setMount: (element: HTMLElement | null) => void }>({ mount: null, setMount: () => undefined })

export function HeaderSlotProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [mount, setMount] = useState<HTMLElement | null>(null)
  return <HeaderSlotContext.Provider value={{ mount, setMount }}>{children}</HeaderSlotContext.Provider>
}

/** The region in the top bar that screen headers land in; empty on screens that pass nothing. */
export function HeaderSlotTarget({ className }: { className?: string }): React.JSX.Element {
  const { setMount } = useContext(HeaderSlotContext)
  return <div ref={setMount} className={className} />
}

/** Renders its children into the top bar instead of in place. */
export function HeaderSlot({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { mount } = useContext(HeaderSlotContext)
  return mount ? createPortal(children, mount) : null
}
