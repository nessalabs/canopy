import type { PreviewedAttachment } from '@/components/agent/attachment-preview'

/** What a reader shows: an issue or PR, a file attached on GitHub, text staged in a composer, or the whiteboard's plan. */
export type Reading = { kind: 'issue'; number: number } | { kind: 'github'; url: string } | { kind: 'staged'; attachment: PreviewedAttachment } | { kind: 'plan' }

/** One reader tab: the readings it went through, the one on screen last. `R` is what a reader reads — `Reading` for the Issues reader. */
export interface ReaderTab<R = Reading> {
  id: string
  trail: R[]
}

export interface ReaderTabs<R = Reading> {
  tabs: ReaderTab<R>[]
  active: string | undefined
}

export const sameReading = <R>(a: R | undefined, b: R): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What the tab on screen shows. */
export const activeReading = <R>(state: ReaderTabs<R>): R | undefined => state.tabs.find((t) => t.id === state.active)?.trail.at(-1)

let nextTabId = 0
const tab = <R>(reading: R): ReaderTab<R> => ({ id: `reader-${++nextTabId}`, trail: [reading] })

const withActive = <R>(state: ReaderTabs<R>, update: (tab: ReaderTab<R>) => ReaderTab<R>): ReaderTabs<R> => ({
  ...state,
  tabs: state.tabs.map((t) => (t.id === state.active ? update(t) : t))
})

/**
 * How the reader's tabs move, as pure steps. `show` brings a reading up — the tab already
 * showing it, else a new one; with `newTab`, always a new one. `open` puts it in the tab on screen, starting that tab's trail
 * over (a pick from a list). `follow` is a link: onto the trail of the tab on screen, or with
 * `newTab` into a tab of its own. `back` steps the tab on screen back along its trail.
 */
export const readerSteps = {
  show: <R>(state: ReaderTabs<R>, reading: R, newTab = false): ReaderTabs<R> => {
    if (newTab) return readerSteps.follow(state, reading, true)
    const showing = state.tabs.find((t) => sameReading(t.trail.at(-1), reading))
    if (showing) return { ...state, active: showing.id }
    const added = tab(reading)
    return { tabs: [...state.tabs, added], active: added.id }
  },
  open: <R>(state: ReaderTabs<R>, reading: R): ReaderTabs<R> => {
    if (!state.active) return readerSteps.show(state, reading)
    return withActive(state, (t) => ({ ...t, trail: [reading] }))
  },
  follow: <R>(state: ReaderTabs<R>, reading: R, newTab: boolean): ReaderTabs<R> => {
    if (newTab || !state.active) {
      const added = tab(reading)
      return { tabs: [...state.tabs, added], active: added.id }
    }
    return withActive(state, (t) => (sameReading(t.trail.at(-1), reading) ? t : { ...t, trail: [...t.trail, reading] }))
  },
  back: <R>(state: ReaderTabs<R>): ReaderTabs<R> => withActive(state, (t) => (t.trail.length > 1 ? { ...t, trail: t.trail.slice(0, -1) } : t)),
  select: <R>(state: ReaderTabs<R>, id: string): ReaderTabs<R> => ({ ...state, active: id }),
  /** Closing the tab on screen hands over to its right neighbour, else its left. */
  close: <R>(state: ReaderTabs<R>, id: string): ReaderTabs<R> => {
    const index = state.tabs.findIndex((t) => t.id === id)
    const tabs = state.tabs.filter((t) => t.id !== id)
    const active = state.active === id ? (tabs[index] ?? tabs[index - 1])?.id : state.active
    return { tabs, active }
  }
}

export const EMPTY_READER: ReaderTabs<never> = { tabs: [], active: undefined }
