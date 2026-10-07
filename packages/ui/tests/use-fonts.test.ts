import { describe, expect, it } from 'vitest'

import { DEFAULT_FONTS, codeFontFeatures, codeFontStack, customFamily, parseFonts, uiFontStack } from '../src/lib/use-fonts'

describe('font stacks', () => {
  it('defaults to Ioskeley Mono for code and Geist for the interface, as globals.css does', () => {
    expect(codeFontStack(DEFAULT_FONTS)).toBe('"Ioskeley Mono", ui-monospace, monospace')
    expect(uiFontStack(DEFAULT_FONTS)).toBe('"Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif')
  })

  it('puts a custom family in front of the fallback, quoted', () => {
    const prefs = { ...DEFAULT_FONTS, code: { id: 'custom' as const, custom: 'Fira Code' } }
    expect(codeFontStack(prefs)).toBe('"Fira Code", ui-monospace, monospace')
  })

  it('falls back to the default font when the custom name is empty', () => {
    const prefs = { ...DEFAULT_FONTS, code: { id: 'custom' as const, custom: '   ' } }
    expect(codeFontStack(prefs)).toBe(codeFontStack(DEFAULT_FONTS))
  })

  it('turns ligatures off unless asked for', () => {
    expect(codeFontFeatures(DEFAULT_FONTS)).toBe('"liga" 0, "calt" 0')
    expect(codeFontFeatures({ ...DEFAULT_FONTS, ligatures: true })).toBe('normal')
  })
})

describe('customFamily', () => {
  it('keeps a quoted name or a list as typed', () => {
    expect(customFamily("'Iosevka Term'")).toBe("'Iosevka Term'")
    expect(customFamily('Iosevka, Menlo')).toBe('Iosevka, Menlo')
  })

  it('strips what could end the declaration', () => {
    expect(customFamily('Evil; color: red}')).toBe('"Evil color: red"')
    expect(customFamily(';{}')).toBe('')
  })
})

describe('parseFonts', () => {
  it('reads what was stored', () => {
    const stored = { code: { id: 'geist-mono', custom: 'Fira Code' }, ui: { id: 'system', custom: '' }, ligatures: true }
    expect(parseFonts(JSON.stringify(stored))).toEqual(stored)
  })

  it('falls back key by key on an unknown id or a corrupt value', () => {
    expect(parseFonts(null)).toEqual(DEFAULT_FONTS)
    expect(parseFonts('not json')).toEqual(DEFAULT_FONTS)
    expect(parseFonts(JSON.stringify({ code: { id: 'comic-sans' }, ligatures: 'yes' }))).toEqual(DEFAULT_FONTS)
  })
})
