import { useState } from 'react'

import { EMPTY_READER, readerSteps, type Reading, type ReaderTabs } from './reader-tabs'

/** A reader's tabs and the steps that move them — the Issues reader's readings by default, or any `R` a reader reads. */
export function useReader<R = Reading>() {
  const [state, setState] = useState<ReaderTabs<R>>(EMPTY_READER)
  const step =
    <Args extends unknown[]>(fn: (state: ReaderTabs<R>, ...args: Args) => ReaderTabs<R>) =>
    (...args: Args): void =>
      setState((current) => fn(current, ...args))
  const tab = state.tabs.find((t) => t.id === state.active)
  return {
    state,
    current: tab?.trail.at(-1),
    previous: tab?.trail.at(-2),
    show: step(readerSteps.show<R>),
    open: step(readerSteps.open<R>),
    follow: step(readerSteps.follow<R>),
    back: step(readerSteps.back<R>),
    select: step(readerSteps.select<R>),
    close: step(readerSteps.close<R>),
    /** Any change of its own, for steps that depend on what is on screen. */
    update: (change: (state: ReaderTabs<R>) => ReaderTabs<R>): void => setState(change)
  }
}

export type Reader<R = Reading> = ReturnType<typeof useReader<R>>
