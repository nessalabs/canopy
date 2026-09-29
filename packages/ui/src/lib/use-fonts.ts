import { useSyncExternalStore } from 'react'

/**
 * The interface and code fonts. Like the theme, a font is about the screen in front of you — a
 * font that is installed here may not be on the machine the daemon runs on — so the choice lives
 * in this browser or app window, not in the daemon's settings.
 *
 * globals.css reads both through `--canopy-font-ui` / `--canopy-font-code`, and Tailwind's
 * `font-sans` / `font-mono`, the diff view's shadow root and code blocks all follow those. The
 * editor cannot read a css variable, so `CodeEditor` subscribes here and hands it the literal stack.
 */

export type CodeFontId = 'jetbrains-mono' | 'geist-mono' | 'sf-mono' | 'menlo' | 'custom'
export type UiFontId = 'geist' | 'system' | 'custom'

export interface FontChoice<Id extends string> {
  id: Id
  /** The family typed in when `id` is `custom`; kept when another preset is picked, so it comes back. */
  custom: string
}

export interface FontPreferences {
  code: FontChoice<CodeFontId>
  ui: FontChoice<UiFontId>
  /** Ligatures draw `!=` as `≠`; off by default so a diff shows the characters that are in the file. */
  ligatures: boolean
}

const CODE_FALLBACK = 'ui-monospace, monospace'
const UI_FALLBACK = 'ui-sans-serif, system-ui, sans-serif'

/** Bundled fonts first: they look the same on every machine. */
export const CODE_FONTS: Record<Exclude<CodeFontId, 'custom'>, { label: string; family: string; bundled: boolean }> = {
  'jetbrains-mono': { label: 'JetBrains Mono', family: '"JetBrains Mono Variable", "JetBrains Mono"', bundled: true },
  'geist-mono': { label: 'Geist Mono', family: '"Geist Mono Variable", "Geist Mono"', bundled: true },
  'sf-mono': { label: 'SF Mono', family: '"SF Mono", SFMono-Regular', bundled: false },
  menlo: { label: 'Menlo', family: 'Menlo', bundled: false }
}

export const UI_FONTS: Record<Exclude<UiFontId, 'custom'>, { label: string; family: string; bundled: boolean }> = {
  geist: { label: 'Geist', family: '"Geist Variable", "Geist"', bundled: true },
  system: { label: 'System', family: '-apple-system, BlinkMacSystemFont, "Segoe UI"', bundled: false }
}

export const DEFAULT_FONTS: FontPreferences = {
  code: { id: 'jetbrains-mono', custom: '' },
  ui: { id: 'geist', custom: '' },
  ligatures: false
}

/**
 * A typed family name as css: quoted unless it is already, stripped of anything that could end
 * the declaration. Empty when nothing usable is left.
 */
export function customFamily(raw: string): string {
  const name = raw.replace(/[;{}\\<>]/g, '').trim()
  if (!name) return ''
  if (/^(["']).*\1$/.test(name) || name.includes(',')) return name
  return `"${name.replace(/"/g, '')}"`
}

function stack<Id extends string>(choice: FontChoice<Id>, presets: Record<string, { family: string }>, fallback: string, defaultId: Id): string {
  const family = choice.id === 'custom' ? customFamily(choice.custom) : (presets[choice.id]?.family ?? '')
  // A custom name that is empty still falls through to the default rather than to the bare fallback.
  const primary = family || (presets[defaultId] as { family: string }).family
  return `${primary}, ${fallback}`
}

export const codeFontStack = (prefs: FontPreferences): string => stack(prefs.code, CODE_FONTS, CODE_FALLBACK, DEFAULT_FONTS.code.id)
export const uiFontStack = (prefs: FontPreferences): string => stack(prefs.ui, UI_FONTS, UI_FALLBACK, DEFAULT_FONTS.ui.id)
export const codeFontFeatures = (prefs: FontPreferences): string => (prefs.ligatures ? 'normal' : '"liga" 0, "calt" 0')

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function readChoice<Id extends string>(value: unknown, ids: readonly string[], fallback: FontChoice<Id>): FontChoice<Id> {
  if (!isObject(value)) return fallback
  const id = typeof value['id'] === 'string' && ids.includes(value['id']) ? (value['id'] as Id) : fallback.id
  const custom = typeof value['custom'] === 'string' ? value['custom'] : ''
  return { id, custom }
}

/** Whatever was stored, as preferences: an unknown id or a corrupt value falls back key by key. */
export function parseFonts(raw: string | null): FontPreferences {
  if (!raw) return DEFAULT_FONTS
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return DEFAULT_FONTS
  }
  if (!isObject(value)) return DEFAULT_FONTS
  return {
    code: readChoice(value['code'], [...Object.keys(CODE_FONTS), 'custom'], DEFAULT_FONTS.code),
    ui: readChoice(value['ui'], [...Object.keys(UI_FONTS), 'custom'], DEFAULT_FONTS.ui),
    ligatures: typeof value['ligatures'] === 'boolean' ? value['ligatures'] : DEFAULT_FONTS.ligatures
  }
}

const STORAGE_KEY = 'canopy-fonts'

function stored(): FontPreferences {
  try {
    return parseFonts(localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_FONTS
  }
}

let current: FontPreferences | undefined
const listeners = new Set<() => void>()

function paint(prefs: FontPreferences): void {
  const style = document.documentElement.style
  style.setProperty('--canopy-font-code', codeFontStack(prefs))
  style.setProperty('--canopy-font-ui', uiFontStack(prefs))
  style.setProperty('--canopy-font-code-features', codeFontFeatures(prefs))
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Another window (the tray, a popped-out diagram) changed the fonts; follow it. */
function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return
  current = parseFonts(event.newValue)
  paint(current)
  notify()
}

function ensure(): FontPreferences {
  if (current === undefined) {
    current = stored()
    paint(current)
    window.addEventListener('storage', onStorage)
  }
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setFonts(update: (current: FontPreferences) => FontPreferences): void {
  const next = update(ensure())
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private windows can refuse storage; the choice still holds until the window closes.
  }
  paint(next)
  notify()
}

/** The current fonts, painted onto the document on first use. */
export const currentFonts = (): FontPreferences => ensure()

export function useFonts(): { fonts: FontPreferences; setFonts: typeof setFonts } {
  const fonts = useSyncExternalStore(subscribe, ensure)
  return { fonts, setFonts }
}
