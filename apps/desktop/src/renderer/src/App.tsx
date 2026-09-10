import { useEffect, useState } from 'react'
import { CanopyApp, type DaemonConnection } from '@canopy/ui'

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
      titleBarInset={window.canopy.platform === 'darwin'}
      initialConnection={connection ?? undefined}
      openExternal={window.canopy.openExternal}
    />
  )
}
