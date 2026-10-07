import { useEffect, useRef } from 'react'

/** The part of a key event a binding is matched on. */
export type HotkeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>

/**
 * The name a binding table uses for a key press — `1`, `shift+1`, `[`, `\` — or undefined for a
 * press no plain-key binding should take (one held with Cmd, Ctrl or Alt). Digits are read off
 * the physical key, so Shift+1 is `shift+1` on every layout rather than `!`.
 */
export function comboOf(event: HotkeyEvent): string | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1]
  const key = digit ?? event.key
  return event.shiftKey && digit ? `shift+${key}` : key
}

/** Whether a key press is someone typing, which no plain-key binding may take. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * Plain-key shortcuts for as long as the caller is mounted, as a table from combo to action.
 * The table is read through a ref, so callers can pass a fresh object every render.
 */
export function useHotkeys(bindings: Record<string, () => void>): void {
  const table = useRef(bindings)
  table.current = bindings
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTyping(event.target)) return
      const combo = comboOf(event)
      const action = combo === undefined ? undefined : table.current[combo]
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
