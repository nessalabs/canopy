import { useEffect, useState } from 'react'
import { CanopyApp, type DaemonConnection } from '@canopy/ui'

export default function App(): React.JSX.Element {
  const [connection, setConnection] = useState<DaemonConnection | null>()

  useEffect(() => {
    void window.canopy.getDaemonConnection().then(setConnection)
  }, [])

  if (connection === undefined) return <></>
  return (
    <CanopyApp
      platform="desktop"
      initialConnection={connection ?? undefined}
      openExternal={window.canopy.openExternal}
    />
  )
}
