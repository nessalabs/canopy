import React from 'react'
import ReactDOM from 'react-dom/client'

import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@canopy/ui/styles/globals.css'

import { AvatarLab } from '@canopy/ui/lab/avatar'

/** A dev-only bench at /lab.html: the agent avatar's motions, with no daemon behind them. */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AvatarLab />
  </React.StrictMode>
)
