import React from 'react'
import ReactDOM from 'react-dom/client'

import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@canopy/ui/styles/globals.css'

import { CanopyApp } from '@canopy/ui'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CanopyApp platform="web" />
  </React.StrictMode>
)
