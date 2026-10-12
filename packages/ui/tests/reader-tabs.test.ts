import { describe, expect, it } from 'vitest'

import { EMPTY_READER, readerSteps, type Reading } from '@/lib/reader-tabs'

const issue = (number: number): Reading => ({ kind: 'issue', number })
const shown = (state: typeof EMPTY_READER) => state.tabs.find((t) => t.id === state.active)?.trail.at(-1)

describe('reader tabs', () => {
  it('follows a link in the tab on screen, and Back returns', () => {
    let state = readerSteps.show(EMPTY_READER, issue(249))
    state = readerSteps.follow(state, issue(158), false)
    expect(state.tabs).toHaveLength(1)
    expect(shown(state)).toEqual(issue(158))
    state = readerSteps.back(state)
    expect(shown(state)).toEqual(issue(249))
  })

  it('opens a shift-clicked link in a tab of its own, keeping the first where it was', () => {
    let state = readerSteps.show(EMPTY_READER, issue(249))
    state = readerSteps.follow(state, issue(158), true)
    expect(state.tabs.map((t) => t.trail.at(-1))).toEqual([issue(249), issue(158)])
    expect(shown(state)).toEqual(issue(158))
  })

  it('brings up the tab already showing a reading instead of opening another', () => {
    let state = readerSteps.show(EMPTY_READER, issue(249))
    state = readerSteps.follow(state, issue(158), true)
    state = readerSteps.show(state, issue(249))
    expect(state.tabs).toHaveLength(2)
    expect(shown(state)).toEqual(issue(249))
  })

  it('starts the tab on screen over for a pick from the list', () => {
    let state = readerSteps.show(EMPTY_READER, issue(249))
    state = readerSteps.follow(state, issue(158), false)
    state = readerSteps.open(state, issue(7))
    expect(state.tabs[0]!.trail).toEqual([issue(7)])
  })

  it('hands a closed tab’s place to its neighbour', () => {
    let state = readerSteps.show(EMPTY_READER, issue(1))
    state = readerSteps.follow(state, issue(2), true)
    state = readerSteps.follow(state, issue(3), true)
    state = readerSteps.select(state, state.tabs[1]!.id)
    state = readerSteps.close(state, state.tabs[1]!.id)
    expect(shown(state)).toEqual(issue(3))
    state = readerSteps.close(state, state.active!)
    expect(shown(state)).toEqual(issue(1))
  })
})
