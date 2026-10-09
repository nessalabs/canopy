import { useMemo, useState } from 'react'

import type { Against, GitHubNote, GitHubThread, ReviewComment, Worktree } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { useComments, usePrefetchPullRequest, useProviders, usePullRequest, usePullRequestThreads } from '@/lib/api-hooks'
import { GIT_PANES, linkQuery, parseGitLink, type GitPane } from '@/lib/environment-ui'
import type { ReviewTarget } from '@/lib/use-agent-turn'
import { useHotkeys } from '@/lib/use-hotkeys'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { ChangesView } from './changes-view'
import { CommentsPanel } from './comments-panel'
import type { ExplorerFocus } from './diff-explorer'
import { DiffTools, GitActions, GitViewTabs } from './git-chrome'
import { HistoryView } from './history-view'
import { MergeDialog } from './merge-dialog'
import { PullRequestView } from './pull-request-view'
import { GitHubThreadsPanel, threadAsNote, threadsAsComments } from './pull-request/threads'
import { ReviewTargetDialog } from './review-target-dialog'
import { SendToAgentProvider } from './send-to-agent'

type Pane = GitPane

/** A jump from the Comments pane: which view, which commit (History only), which file and comment. */
interface Jump {
  pane: Pane
  commitSha?: string
  focus: ExplorerFocus
}

/**
 * What the session picker is about to send: from the toolbar, every unsent local comment plus the
 * ticked GitHub threads; from one comment's own button, that comment and nothing else.
 */
interface SendRequest {
  github: GitHubNote[]
  local: boolean
}

const jumpFor = (comment: ReviewComment): Jump => ({
  pane: comment.commitSha ? 'history' : 'changes',
  commitSha: comment.commitSha,
  focus: { path: comment.file, commentId: comment.id }
})

/**
 * Git = Changes (working tree) | History (log + per-commit diff) | Pull request (the branch's PR
 * on GitHub) | Comments (everything left on Changes or History). Its tabs, diff switches and
 * primary action live in the top bar; the pane below starts at its content.
 */
export function GitTab({
  worktree,
  agent,
  pane,
  onPaneChange,
  onSendForReview
}: {
  worktree: Worktree
  agent: WorktreeAgent
  pane: Pane
  onPaneChange: (pane: Pane) => void
  onSendForReview: (target: ReviewTarget, note: string | undefined, github: GitHubNote[], local: boolean) => void
}): React.JSX.Element {
  const comments = useComments(worktree.id).data ?? []
  const providers = useProviders().data ?? []
  const [mode, setMode] = useState<DiffMode>('unified')
  // A link can open Changes on what it compares against, or History on a commit: the Command
  // Center links its drift, uncommitted and last-commit cells here.
  const [link] = useState(() => parseGitLink(linkQuery()))
  const [against, setAgainst] = useState<Against>(link.against ?? 'head')
  const [jump, setJump] = useState<Jump>()
  const [request, setRequest] = useState<SendRequest>()
  const [merging, setMerging] = useState(false)
  useHotkeys(Object.fromEntries(GIT_PANES.map((id, index) => [`shift+${index + 1}`, () => onPaneChange(id)])))
  const unsent = comments.filter((c) => !c.sent)
  const prefetchPr = usePrefetchPullRequest(worktree.id)
  // GitHub's review threads: read once the Comments or Pull request pane is open, and shown in
  // both — as cards under the local comments, and on their lines in the PR's Files changed.
  const showsThreads = pane === 'comments' || pane === 'pr'
  const prQuery = usePullRequest(worktree.id, showsThreads)
  const host = prQuery.data?.gh.host ?? null
  const threadsQuery = usePullRequestThreads(worktree.id, showsThreads && Boolean(prQuery.data?.pr))
  const threads = threadsQuery.data?.threads ?? []
  const [pickedThreads, setPickedThreads] = useState<Set<string>>(new Set())
  const [prFocus, setPrFocus] = useState<ExplorerFocus>()
  const githubComments = useMemo(() => threadsAsComments(threads, worktree.id, host), [threads, worktree.id, host])

  const onJump = (comment: ReviewComment): void => {
    const next = jumpFor(comment)
    setJump(next)
    onPaneChange(next.pane)
  }
  const onJumpThread = (thread: GitHubThread): void => {
    setPrFocus({ path: thread.file, commentId: thread.comments[0] ? `gh:${thread.comments[0].id}` : undefined })
    onPaneChange('pr')
  }
  const pickThread = (id: string, on: boolean): void =>
    setPickedThreads((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const sendPicked = (): void => setRequest({ github: threads.filter((thread) => pickedThreads.has(thread.id)).map(threadAsNote), local: true })
  const sendOne = (note: GitHubNote): void => setRequest({ github: [note], local: false })
  const shared = { comments, mode }
  const focusFor = (target: Pane): ExplorerFocus | undefined => (jump?.pane === target ? jump.focus : undefined)

  return (
    <SendToAgentProvider value={sendOne}>
      <Tabs value={pane} onValueChange={(value) => onPaneChange(value as Pane)} className="flex min-h-0 flex-1 flex-col">
        <GitViewTabs dirty={worktree.status?.dirtyTotal ?? 0} comments={comments.length} onPrefetchPr={prefetchPr} />
        {pane === 'comments' ? null : <DiffTools mode={mode} onModeChange={setMode} against={pane === 'changes' ? against : undefined} onAgainstChange={setAgainst} baseBranch={worktree.baseBranch} />}
        <GitActions
          worktree={worktree}
          pane={pane}
          onPaneChange={onPaneChange}
          mode={mode}
          onModeChange={setMode}
          against={against}
          onAgainstChange={setAgainst}
          pendingReview={unsent.length + pickedThreads.size}
          sending={agent.turn.busy}
          onSendForReview={sendPicked}
          onMerge={() => setMerging(true)}
          prUrl={prQuery.data?.pr?.url}
        />
        <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
          <ChangesView worktree={worktree} focus={focusFor('changes')} against={against} {...shared} />
        </TabsContent>
        <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
          <HistoryView worktreeId={worktree.id} focusCommit={jump?.commitSha ?? link.commit} focus={focusFor('history')} {...shared} />
        </TabsContent>
        <TabsContent value="pr" className="flex min-h-0 flex-1 flex-col">
          <PullRequestView worktree={worktree} review={shared} githubComments={githubComments} focus={prFocus} onOpenChanges={() => onPaneChange('changes')} />
        </TabsContent>
        <TabsContent value="comments" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
          <CommentsPanel worktreeId={worktree.id} comments={comments} onJump={onJump} />
          {threadsQuery.data ? (
            <GitHubThreadsPanel number={threadsQuery.data.number} threads={threads} host={host} picked={pickedThreads} onPick={pickThread} onJump={onJumpThread} onSend={sendPicked} sending={agent.turn.busy} />
          ) : null}
        </TabsContent>
      </Tabs>
      <MergeDialog worktree={worktree} open={merging} onOpenChange={setMerging} />
      <ReviewTargetDialog
        open={request !== undefined}
        onOpenChange={(open) => (open ? undefined : setRequest(undefined))}
        providers={providers}
        sessions={agent.sessions}
        initialTarget={agent.selected ? { provider: agent.selected.provider, sessionId: agent.selected.sessionId } : undefined}
        count={(request?.local ? unsent.length : 0) + (request?.github.length ?? 0)}
        onSend={(target, note) => {
          if (!request) return
          setRequest(undefined)
          if (request.local) setPickedThreads(new Set())
          onSendForReview(target, note, request.github, request.local)
        }}
      />
    </SendToAgentProvider>
  )
}
