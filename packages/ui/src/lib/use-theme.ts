import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'canopy-theme'

function storedTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Nessa tokens flip on a `.dark` class on the document element, so the theme
 * lives outside React's tree — this module owns the class and persists the
 * choice. It is a single shared store rather than per-component state: the
 * class alone would only repaint token-driven colours, while Shiki-rendered
 * surfaces (CodeBlock, DiffView, MessageMarkdown's fences) take the mode as a
 * prop and so must re-render on every toggle, wherever the toggle came from.
 */
let current: Theme | undefined
const listeners = new Set<() => void>()

function apply(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
  localStorage.setItem(STORAGE_KEY, theme)
}

function snapshot(): Theme {
  if (current === undefined) {
    current = storedTheme()
    apply(current)
  }
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setTheme(theme: Theme): void {
  if (theme === snapshot()) return
  current = theme
  apply(theme)
  for (const listener of listeners) listener()
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, snapshot)
  const toggleTheme = useCallback(() => {
    setTheme(snapshot() === 'dark' ? 'light' : 'dark')
  }, [])
  return { theme, toggleTheme }
}
