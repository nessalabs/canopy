import { useState } from 'react'

import type { ChangedFile, SessionRef, Worktree } from '@canopy/shared'

import { useTranscriptModel } from '@/lib/use-transcript-model'
import { useWorktreeAgent } from '@/lib/use-worktree-agent'

import { Conversation } from './conversation'

/**
 * A session opened beside the main conversation, in a pane of its own: its own transcript, its
 * own composer and its own running turn, so two agents can be read and talked to side by side.
 */
export function SessionPane({ worktree, session, changedFiles }: { worktree: Worktree; session: SessionRef; changedFiles: ChangedFile[] }): React.JSX.Element {
  const agent = useWorktreeAgent(worktree, session)
  const model = useTranscriptModel(agent.history.data, agent.turn)
  const [quote, setQuote] = useState<{ id: number; text: string }>()
  return (
    <Conversation
      worktree={worktree}
      agent={agent}
      model={model}
      changedFiles={changedFiles}
      quote={quote}
      onQuote={(text) => setQuote({ id: Date.now(), text })}
      onQuoteStaged={() => setQuote(undefined)}
    />
  )
}
