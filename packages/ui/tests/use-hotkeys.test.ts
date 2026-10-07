import { describe, expect, it } from 'vitest'

import { comboOf, type HotkeyEvent } from '../src/lib/use-hotkeys'

const press = (key: string, code: string, mods: Partial<HotkeyEvent> = {}): HotkeyEvent => ({ key, code, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods })

describe('comboOf', () => {
  it('names plain keys by the character they type', () => {
    expect(comboOf(press('[', 'BracketLeft'))).toBe('[')
    expect(comboOf(press('\\', 'Backslash'))).toBe('\\')
  })

  it('reads digits off the physical key, so Shift+1 is not "!"', () => {
    expect(comboOf(press('1', 'Digit1'))).toBe('1')
    expect(comboOf(press('!', 'Digit1', { shiftKey: true }))).toBe('shift+1')
  })

  it('leaves presses held with Cmd, Ctrl or Alt to the app and the browser', () => {
    expect(comboOf(press('1', 'Digit1', { metaKey: true }))).toBeUndefined()
    expect(comboOf(press('[', 'BracketLeft', { ctrlKey: true }))).toBeUndefined()
    expect(comboOf(press('1', 'Digit1', { altKey: true }))).toBeUndefined()
  })
})
