import type { ChangedFile, SessionRef, Worktree } from '@canopy/shared'

import { useStaging } from '@/lib/use-staging'
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
  const staging = useStaging()
  return (
    <Conversation
      worktree={worktree}
      agent={agent}
      model={model}
      changedFiles={changedFiles}
      staging={staging}
    />
  )
}
