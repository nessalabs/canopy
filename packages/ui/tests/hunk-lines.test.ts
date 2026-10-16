import { describe, expect, it } from 'vitest'

import { hunkLines } from '../src/components/git/pull-request/threads'

describe('hunkLines', () => {
  it('has no lines without a hunk', () => {
    expect(hunkLines(undefined)).toEqual([])
    expect(hunkLines('')).toEqual([])
  })

  it('drops the header, the no-newline marker and trailing empties, so the commented line is last', () => {
    expect(hunkLines('@@ -1,2 +1,3 @@\n a\n+b\n\\ No newline at end of file\n')).toEqual([' a', '+b'])
  })
})
