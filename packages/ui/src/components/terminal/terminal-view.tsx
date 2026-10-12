import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import type { TerminalServerMessage } from '@canopy/shared'

import { useTheme } from '@/lib/use-theme'
import { useApi } from '@/providers/api'
import { usePlatform } from '@/providers/platform'

/**
 * Any CSS colour as `#rrggbb`, which xterm can read: Canopy's tokens are oklch, so the browser
 * paints one pixel in it and reads the pixel back.
 */
function toHex(color: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) return color
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`
}

/** The terminal in Canopy's colours: the card behind it, its text, and its selection. */
function themeFromPage(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string): string => toHex(css.getPropertyValue(name).trim() || '#000')
  return { background: token('--card'), foreground: token('--foreground'), cursor: token('--foreground'), selectionBackground: `${token('--ring')}66` }
}

/**
 * One shell, drawn by xterm.js and wired to the daemon over a WebSocket: keystrokes go out,
 * output comes in (its recent past first), and the size follows the panel. Hidden — another tab
 * on screen — it stays connected and keeps drawing, so coming back to it loses nothing.
 */
export function TerminalView({ terminalId, active }: { terminalId: string; active: boolean }): React.JSX.Element {
  const api = useApi()
  const { openExternal } = usePlatform()
  const { theme } = useTheme()
  // Read through a ref: the platform hands out a new function on some renders, and the shell's
  // socket must not be torn down and reopened for that.
  const openLink = useRef(openExternal)
  openLink.current = openExternal
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal>(null)
  const fitRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const font = getComputedStyle(document.documentElement).getPropertyValue('--canopy-font-code').trim() || 'monospace'
    const terminal = new Terminal({ fontFamily: font, fontSize: 12, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: themeFromPage() })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(new WebLinksAddon((_event, uri) => openLink.current(uri)))
    terminal.open(element)
    term.current = terminal

    let disposed = false
    const { url, protocols } = api.terminalSocket(terminalId)
    const socket = new WebSocket(url, protocols)
    const send = (message: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }
    // A hidden panel has no size; fitting it would squash the shell to two columns.
    const resize = (): void => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return
      fit.fit()
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
    }
    fitRef.current = resize
    socket.onopen = resize
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as TerminalServerMessage
      if (message.type === 'output') terminal.write(message.data)
      else terminal.write(`\r\n\x1b[2m[process exited with code ${message.code}]\x1b[0m\r\n`)
    }
    // A socket that never opened says so, rather than leaving a blank screen with a cursor.
    let opened = false
    socket.addEventListener('open', () => (opened = true))
    socket.onclose = (event) => {
      if (event.code === 4404) terminal.write('\r\n\x1b[2m[this terminal is gone]\x1b[0m\r\n')
      else if (!opened) terminal.write(`\x1b[31mCould not connect to the terminal (code ${event.code}).\x1b[0m\r\nCanopy reaches it at ${url}\r\n`)
      else if (!disposed) terminal.write('\r\n\x1b[2m[disconnected from the daemon]\x1b[0m\r\n')
    }
    const input = terminal.onData((data) => send({ type: 'input', data }))
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => {
      disposed = true
      observer.disconnect()
      input.dispose()
      socket.close()
      terminal.dispose()
      term.current = null
    }
  }, [api, terminalId])

  // Light and dark repaint the terminal in place; the shell does not notice.
  useEffect(() => {
    if (term.current) term.current.options.theme = themeFromPage()
  }, [theme])

  useEffect(() => {
    if (!active) return
    fitRef.current()
    term.current?.focus()
  }, [active])

  return <div ref={host} className="h-full min-h-0 w-full overflow-hidden px-2 py-1" hidden={!active} />
}
