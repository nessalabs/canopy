import { describe, expect, it } from 'vitest'

import { tabTitles } from '@/components/git/file-panes'

describe('tabTitles', () => {
  it('names each tab by its file', () => {
    expect(tabTitles(['src/app.ts', 'README.md'])).toEqual(['app.ts', 'README.md'])
  })

  it('adds the folder where two files share a name', () => {
    expect(tabTitles(['src/index.ts', 'lib/index.ts', 'index.ts'])).toEqual(['index.ts — src', 'index.ts — lib', 'index.ts'])
  })
})
