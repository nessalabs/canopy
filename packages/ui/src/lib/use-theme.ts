import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'
/** What the user asked for: a fixed theme, or whatever the device is set to. */
export type ThemePreference = Theme | 'system'

const STORAGE_KEY = 'canopy-theme'
const media = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

function storedPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

const resolve = (preference: ThemePreference): Theme => (preference === 'system' ? (media().matches ? 'dark' : 'light') : preference)

/**
 * Nessa tokens flip on a `.dark` class on the document element, so the theme
 * lives outside React's tree — this module owns the class and persists the
 * choice. It is a single shared store rather than per-component state: the
 * class alone would only repaint token-driven colours, while Shiki-rendered
 * surfaces (CodeBlock, DiffView, MessageMarkdown's fences) take the mode as a
 * prop and so must re-render on every toggle, wherever the toggle came from.
 *
 * The store holds the *preference*; `system` resolves against the device and
 * follows it live, so a machine that goes dark at sunset takes Canopy with it.
 */
let preference: ThemePreference | undefined
let current: Theme | undefined
const listeners = new Set<() => void>()
let watching = false

function paint(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** The device changed its mind; only a `system` preference cares. */
function onDeviceChange(): void {
  if (preference !== 'system') return
  const next = resolve('system')
  if (next === current) return
  current = next
  paint(next)
  notify()
}

function ensure(): void {
  if (preference !== undefined) return
  preference = storedPreference()
  current = resolve(preference)
  paint(current)
  if (!watching) {
    watching = true
    media().addEventListener('change', onDeviceChange)
  }
}

function themeSnapshot(): Theme {
  ensure()
  return current as Theme
}

function preferenceSnapshot(): ThemePreference {
  ensure()
  return preference as ThemePreference
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setPreference(next: ThemePreference): void {
  ensure()
  if (next === preference) return
  preference = next
  if (next === 'system') localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, next)
  const theme = resolve(next)
  if (theme !== current) {
    current = theme
    paint(theme)
  }
  notify()
}

export function useTheme(): { theme: Theme; preference: ThemePreference; setPreference: (next: ThemePreference) => void; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, themeSnapshot)
  const pref = useSyncExternalStore(subscribe, preferenceSnapshot)
  // The header button is a quick flip, so it pins the opposite theme; "follow device" is
  // chosen deliberately, in preferences.
  const toggleTheme = useCallback(() => {
    setPreference(themeSnapshot() === 'dark' ? 'light' : 'dark')
  }, [])
  return { theme, preference: pref, setPreference, toggleTheme }
}
