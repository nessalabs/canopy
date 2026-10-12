import { useEffect } from 'react'

import type { ChangedFile, SessionRef, Worktree } from '@canopy/shared'

import { useStaging } from '@/lib/use-staging'
import { useTranscriptModel } from '@/lib/use-transcript-model'
import { useWorktreeAgent } from '@/lib/use-worktree-agent'

import type { PreviewedAttachment } from './attachment-preview'
import { Conversation } from './conversation'

/**
 * A session opened beside the main conversation, in a pane of its own: its own transcript, its
 * own composer and its own running turn, so two agents can be read and talked to side by side.
 * Without a `session` the pane composes a new one, and hands it to `onCreated` once it exists.
 */
export function SessionPane({
  worktree,
  session,
  changedFiles,
  onCreated,
  onOpenAttachment
}: {
  worktree: Worktree
  session?: SessionRef
  changedFiles: ChangedFile[]
  onCreated?: (session: SessionRef) => void
  onOpenAttachment?: (attachment: PreviewedAttachment) => void
}): React.JSX.Element {
  const agent = useWorktreeAgent(worktree, session, { follow: false, compose: !session })
  const model = useTranscriptModel(agent.history.data, agent.turn)
  const staging = useStaging()
  const created = session ? undefined : agent.selected
  useEffect(() => {
    if (created) onCreated?.({ provider: created.provider, sessionId: created.sessionId })
  }, [created?.provider, created?.sessionId])
  return (
    <Conversation
      worktree={worktree}
      agent={agent}
      model={model}
      changedFiles={changedFiles}
      staging={staging}
      onOpenAttachment={onOpenAttachment}
    />
  )
}
