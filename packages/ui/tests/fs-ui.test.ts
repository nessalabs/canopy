import { describe, expect, it } from 'vitest'

import { breadcrumbs, filterEntries, withTilde } from '../src/lib/fs-ui'

describe('folder picker helpers', () => {
  it('builds breadcrumbs with absolute paths', () => {
    expect(breadcrumbs('/Users/me/dev/')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'me', path: '/Users/me' },
      { label: 'dev', path: '/Users/me/dev' }
    ])
    expect(breadcrumbs('/')).toEqual([{ label: '/', path: '/' }])
  })

  it('collapses the home prefix', () => {
    expect(withTilde('/Users/me', '/Users/me')).toBe('~')
    expect(withTilde('/Users/me/dev/x', '/Users/me')).toBe('~/dev/x')
    expect(withTilde('/opt/x', '/Users/me')).toBe('/opt/x')
    expect(withTilde('/Users/melon', '/Users/me')).toBe('/Users/melon')
  })

  it('filters names case-insensitively and keeps order', () => {
    const entries = [{ name: 'Apps' }, { name: 'dev' }, { name: 'Devices' }, { name: 'README.md' }]
    expect(filterEntries(entries, 'dev').map((e) => e.name)).toEqual(['dev', 'Devices'])
    expect(filterEntries(entries, '  ')).toEqual(entries)
    expect(filterEntries(entries, 'zzz')).toEqual([])
  })
})
