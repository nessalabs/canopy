import { useEffect, useState } from 'react'
import { CanopyApp, type DaemonConnection } from '@canopy/ui'

/**
 * Pop-out windows — one file, one diagram — are the same renderer on a `/window/…` route, but
 * they wear a normal title bar rather than the main window's hidden-inset one, so nothing of
 * theirs has to clear the traffic lights.
 */
const isPopOut = (): boolean => window.location.hash.startsWith('#/window/')

export default function App(): React.JSX.Element {
  const [connection, setConnection] = useState<DaemonConnection | null>()

  useEffect(() => {
    void window.canopy.getDaemonConnection().then(setConnection)
  }, [])

  // The menu-bar panel opens worktrees here; the app routes on the hash, so setting it is enough.
  useEffect(() => window.canopy.onNavigate((hash) => {
    window.location.hash = hash
  }), [])

  if (connection === undefined) return <></>
  return (
    <CanopyApp
      platform="desktop"
      titleBarInset={window.canopy.platform === 'darwin' && !isPopOut()}
      initialConnection={connection ?? undefined}
      openExternal={window.canopy.openExternal}
      openWindow={window.canopy.openWindow}
    />
  )
}
