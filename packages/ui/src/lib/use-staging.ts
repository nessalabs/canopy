import { useCallback, useState } from 'react'

import type { ChatComposerAttachmentKind } from '@/components/ui/chat-composer'

/** Context handed to a composer from outside it — a quote, a dropped file, a PR — staged as a chip. */
export interface StagedText {
  id: number
  text: string
  /** The chip's name; a transcript quote is named after its length when absent. */
  label?: string
  kind?: ChatComposerAttachmentKind
}

/** One composer's queue: what is waiting for it, how to add to it, and how it reports what it took. */
export interface Staging {
  staged: StagedText[]
  stage: (item: Omit<StagedText, 'id'>) => void
  taken: (ids: ReadonlySet<number>) => void
}

const NONE: StagedText[] = []
let nextId = 0

/**
 * Queues of chips on their way to composers, one per key — a Git Agent tab, say. A queue rather
 * than one slot, because two can arrive before the composer takes either: a new conversation's
 * own chip and the snippet that opened it. The composer reports what it took; only that leaves.
 */
export function useStagingBoard(): { forKey: (key: string) => Staging } {
  const [board, setBoard] = useState<Record<string, StagedText[]>>({})
  const stage = useCallback((key: string, item: Omit<StagedText, 'id'>) => setBoard((current) => ({ ...current, [key]: [...(current[key] ?? NONE), { ...item, id: ++nextId }] })), [])
  const taken = useCallback((key: string, ids: ReadonlySet<number>) => setBoard((current) => ({ ...current, [key]: (current[key] ?? NONE).filter((item) => !ids.has(item.id)) })), [])
  return { forKey: (key) => ({ staged: board[key] ?? NONE, stage: (item) => stage(key, item), taken: (ids) => taken(key, ids) }) }
}

/** A single composer's queue. */
export const useStaging = (): Staging => useStagingBoard().forKey('')
