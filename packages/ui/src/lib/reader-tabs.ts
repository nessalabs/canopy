import type { PreviewedAttachment } from '@/components/agent/attachment-preview'

/** What a reader shows: an issue or PR, a file attached on GitHub, or text staged in a composer. */
export type Reading = { kind: 'issue'; number: number } | { kind: 'github'; url: string } | { kind: 'staged'; attachment: PreviewedAttachment }

/** One reader tab: the readings it went through, the one on screen last. */
export interface ReaderTab {
  id: string
  trail: Reading[]
}

export interface ReaderTabs {
  tabs: ReaderTab[]
  active: string | undefined
}

export const sameReading = (a: Reading | undefined, b: Reading): boolean => JSON.stringify(a) === JSON.stringify(b)

let nextTabId = 0
const tab = (reading: Reading): ReaderTab => ({ id: `reader-${++nextTabId}`, trail: [reading] })

const withActive = (state: ReaderTabs, update: (tab: ReaderTab) => ReaderTab): ReaderTabs => ({
  ...state,
  tabs: state.tabs.map((t) => (t.id === state.active ? update(t) : t))
})

/**
 * How the reader's tabs move, as pure steps. `show` brings a reading up — the tab already
 * showing it, else a new one. `open` puts it in the tab on screen, starting that tab's trail
 * over (a pick from a list). `follow` is a link: onto the trail of the tab on screen, or with
 * `newTab` into a tab of its own. `back` steps the tab on screen back along its trail.
 */
export const readerSteps = {
  show: (state: ReaderTabs, reading: Reading): ReaderTabs => {
    const showing = state.tabs.find((t) => sameReading(t.trail.at(-1), reading))
    if (showing) return { ...state, active: showing.id }
    const added = tab(reading)
    return { tabs: [...state.tabs, added], active: added.id }
  },
  open: (state: ReaderTabs, reading: Reading): ReaderTabs => {
    if (!state.active) return readerSteps.show(state, reading)
    return withActive(state, (t) => ({ ...t, trail: [reading] }))
  },
  follow: (state: ReaderTabs, reading: Reading, newTab: boolean): ReaderTabs => {
    if (newTab || !state.active) {
      const added = tab(reading)
      return { tabs: [...state.tabs, added], active: added.id }
    }
    return withActive(state, (t) => (sameReading(t.trail.at(-1), reading) ? t : { ...t, trail: [...t.trail, reading] }))
  },
  back: (state: ReaderTabs): ReaderTabs => withActive(state, (t) => (t.trail.length > 1 ? { ...t, trail: t.trail.slice(0, -1) } : t)),
  select: (state: ReaderTabs, id: string): ReaderTabs => ({ ...state, active: id }),
  /** Closing the tab on screen hands over to its right neighbour, else its left. */
  close: (state: ReaderTabs, id: string): ReaderTabs => {
    const index = state.tabs.findIndex((t) => t.id === id)
    const tabs = state.tabs.filter((t) => t.id !== id)
    const active = state.active === id ? (tabs[index] ?? tabs[index - 1])?.id : state.active
    return { tabs, active }
  }
}

export const EMPTY_READER: ReaderTabs = { tabs: [], active: undefined }
