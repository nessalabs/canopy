import { useEffect, useMemo, useRef } from 'react'
import { FileCheck2, ScanSearch, Sparkles, SquarePen } from 'lucide-react'

import { latestProposal, SAVED_MESSAGE, type ConfigProposal, type SessionRef, type Worktree } from '@canopy/shared'

import { Conversation, type Starter } from '@/components/agent/conversation'
import { Button } from '@/components/ui/button'
import { readStored, writeStored } from '@/lib/local-store'
import { replayBefore, useTranscriptModel } from '@/lib/use-transcript-model'
import { sameRef, useWorktreeAgent } from '@/lib/use-worktree-agent'

/** The conversation a project's Canopy Agent last had, so the page reopens it. */
const sessionKey = (projectId: string): string => `canopy-config-agent:${projectId}`

const STARTER: Starter = {
  title: 'Canopy Agent',
  note: 'Writes canopy.yaml with you — asking how you want each service and database to run — then starts everything in a throwaway worktree to prove it comes up.',
  suggestions: [
    { id: 'setup', label: 'Set up this repo', hint: 'Reads the repo, asks a few questions, proposes canopy.yaml', icon: <Sparkles className="size-4" />, prompt: 'Set up canopy.yaml for this repo.' },
    { id: 'check', label: 'Check my canopy.yaml', hint: 'Starts every service in a throwaway worktree', icon: <FileCheck2 className="size-4" />, prompt: 'Check that the saved canopy.yaml brings every service up.' },
    { id: 'review', label: 'Review what is there', hint: 'Finds what the file misses compared to the repo', icon: <ScanSearch className="size-4" />, prompt: 'Review the saved canopy.yaml against this repo: what is missing or wrong?' }
  ]
}

/**
 * The Canopy Agent beside the canopy.yaml editor: a Claude conversation in the project's main
 * checkout with the tools to propose the file and check its services. A proposal is handed up
 * as it lands, for the editor to show as a draft; `saved` names the proposal the user has since
 * saved, which the agent is told about so it can go on to check it.
 */
export function ConfigAgentPanel({
  projectId,
  worktree,
  onProposal,
  saved
}: {
  projectId: string
  worktree: Worktree
  onProposal: (proposal: ConfigProposal) => void
  saved: string | undefined
}): React.JSX.Element {
  const configAgent = useMemo(() => ({ projectId }), [projectId])
  const agent = useWorktreeAgent(worktree, undefined, { follow: false, configAgent })
  const model = useTranscriptModel(agent.history.data, agent.turn)
  const claude = agent.providers.includes('claude')

  // Reopen the last conversation, or start composing a new one.
  useEffect(() => {
    if (agent.loading || agent.selected || agent.fresh || !claude) return
    const last = readStored<SessionRef>(sessionKey(projectId))
    if (last && [...agent.sessions, ...agent.elsewhere].some((s) => sameRef(s, last))) agent.select(last)
    else agent.startSession('claude')
  }, [agent.loading, agent.selected, agent.fresh, claude])

  const own = agent.selected ?? (agent.fresh && agent.turn.sessionId ? { provider: agent.fresh, sessionId: agent.turn.sessionId } : undefined)
  useEffect(() => {
    if (own) writeStored(sessionKey(projectId), { provider: own.provider, sessionId: own.sessionId })
  }, [own?.sessionId])

  // Proposals made while the page is open go to the editor; one already in the history when it
  // loaded was dealt with then.
  const events = useMemo(() => [...replayBefore(agent.history.data?.events ?? [], agent.turn.events[0]?.seq), ...agent.turn.events], [agent.history.data, agent.turn.events])
  const proposal = useMemo(() => latestProposal(events), [events])
  const seen = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (agent.history.isPending && !agent.fresh) return
    if (seen.current === undefined) seen.current = proposal?.callId ?? null
    else if (proposal && proposal.callId !== seen.current) {
      seen.current = proposal.callId
      onProposal(proposal)
    }
  }, [proposal?.callId, agent.history.isPending])

  const told = useRef(saved)
  useEffect(() => {
    if (!saved || saved === told.current) return
    told.current = saved
    void (agent.turn.busy ? agent.turn.queueMessage(SAVED_MESSAGE) : agent.turn.sendMessage(SAVED_MESSAGE))
  }, [saved])

  if (!claude) {
    return <p className="p-4 text-xs text-muted-foreground">The Canopy Agent runs on Claude Code, which is not installed or signed in here.</p>
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end px-2">
        <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 text-xs" disabled={agent.turn.busy} onClick={() => agent.startSession('claude')}>
          <SquarePen className="size-3" /> New conversation
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Conversation worktree={worktree} agent={agent} model={model} changedFiles={[]} starter={STARTER} />
      </div>
    </div>
  )
}
