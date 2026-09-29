import React from 'react'
import ReactDOM from 'react-dom/client'

import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/jetbrains-mono'
import '@canopy/ui/styles/globals.css'

import { CanopyApp, type DaemonConnection } from '@canopy/ui'

/**
 * A dev server started by Canopy itself (see canopy.yaml) names the daemon it belongs to and that
 * daemon's token, so the window opens signed in instead of on the connect form.
 */
function preconfiguredConnection(): DaemonConnection | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const url = env['VITE_CANOPY_DAEMON_URL']
  const token = env['VITE_CANOPY_TOKEN']
  return url && token ? { url, token } : undefined
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CanopyApp platform="web" initialConnection={preconfiguredConnection()} />
  </React.StrictMode>
)
