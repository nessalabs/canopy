import { useMemo, useState } from 'react'
import { GitMerge } from 'lucide-react'

import type { GitHubNote, GitHubThread, ReviewComment, Worktree } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useComments, usePrefetchPullRequest, useProviders, usePullRequest, usePullRequestThreads } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import { mergeAffordance } from '@/lib/status'
import type { ReviewTarget } from '@/lib/use-agent-turn'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'
import { parseGitLink, type GitPane } from '@/lib/environment-ui'

import { ChangesView } from './changes-view'
import { CommentsPanel } from './comments-panel'
import type { ExplorerFocus } from './diff-explorer'
import { HistoryView } from './history-view'
import { MergeDialog } from './merge-dialog'
import { PullRequestView } from './pull-request-view'
import { GitHubThreadsPanel, threadAsNote, threadsAsComments } from './pull-request/threads'
import { ReviewTargetDialog } from './review-target-dialog'

type Pane = GitPane

/** A jump from the Comments pane: which view, which commit (History only), which file and comment. */
interface Jump {
  pane: Pane
  commitSha?: string
  focus: ExplorerFocus
}

const jumpFor = (comment: ReviewComment): Jump => ({
  pane: comment.commitSha ? 'history' : 'changes',
  commitSha: comment.commitSha,
  focus: { path: comment.file, commentId: comment.id }
})

/**
 * Git = Changes (working tree) | History (log + per-commit diff) | Pull request (the branch's PR
 * on GitHub) | Comments (everything left on Changes or History).
 */
export function GitTab({ worktree, agent, onSendForReview }: { worktree: Worktree; agent: WorktreeAgent; onSendForReview: (target: ReviewTarget, note: string | undefined, github?: GitHubNote[]) => void }): React.JSX.Element {
  const comments = useComments(worktree.id).data ?? []
  const providers = useProviders().data ?? []
  const [mode, setMode] = useState<DiffMode>('unified')
  // A link can open a pane directly, with what Changes compares against or the commit History
  // selects: the Command Center links its PR, drift, uncommitted and last-commit cells here.
  const [link] = useState(() => parseGitLink(window.location.hash))
  const [pane, setPane] = useState<Pane>(link.pane ?? 'changes')
  const [jump, setJump] = useState<Jump>()
  const [picking, setPicking] = useState(false)
  const [merging, setMerging] = useState(false)
  const unsent = comments.filter((c) => !c.sent)
  const merge = mergeAffordance(worktree)
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
    setPane(next.pane)
  }
  const onJumpThread = (thread: GitHubThread): void => {
    setPrFocus({ path: thread.file, commentId: thread.comments[0] ? `gh:${thread.comments[0].id}` : undefined })
    setPane('pr')
  }
  const pickThread = (id: string, on: boolean): void =>
    setPickedThreads((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const shared = { comments, mode, onModeChange: setMode, onSendForReview: () => setPicking(true), sending: agent.turn.busy }
  const focusFor = (target: Pane): ExplorerFocus | undefined => (jump?.pane === target ? jump.focus : undefined)

  return (
    <>
      <Tabs value={pane} onValueChange={(value) => setPane(value as Pane)} className="flex-1">
        <div className="flex items-center gap-3">
          <TabsList>
            <TabsTrigger value="changes">Changes{worktree.status?.dirtyTotal ? ` · ${worktree.status.dirtyTotal}` : ''}</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="pr" onPointerEnter={prefetchPr} onFocus={prefetchPr}>
              Pull request
            </TabsTrigger>
            <TabsTrigger value="comments">Comments{comments.length ? ` · ${comments.length}` : ''}</TabsTrigger>
          </TabsList>
          {merge.shown ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-auto">
                  <Button variant="outline" size="sm" className="h-8" disabled={!merge.enabled} onClick={() => setMerging(true)}>
                    <GitMerge />
                    {merge.label}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{merge.hint}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <TabsContent value="changes" className="mt-3 flex min-h-0 flex-1 flex-col">
          <ChangesView worktree={worktree} focus={focusFor('changes')} initialAgainst={link.against} {...shared} />
        </TabsContent>
        <TabsContent value="history" className="mt-3 flex min-h-0 flex-1 flex-col">
          <HistoryView worktreeId={worktree.id} focusCommit={jump?.commitSha ?? link.commit} focus={focusFor('history')} {...shared} />
        </TabsContent>
        <TabsContent value="pr" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PullRequestView worktree={worktree} review={shared} githubComments={githubComments} focus={prFocus} onOpenChanges={() => setPane('changes')} />
        </TabsContent>
        <TabsContent value="comments" className="mt-3 flex flex-col gap-6 overflow-y-auto">
          <CommentsPanel worktreeId={worktree.id} comments={comments} onJump={onJump} />
          {threadsQuery.data ? (
            <GitHubThreadsPanel number={threadsQuery.data.number} threads={threads} host={host} picked={pickedThreads} onPick={pickThread} onJump={onJumpThread} onSend={() => setPicking(true)} sending={agent.turn.busy} />
          ) : null}
        </TabsContent>
      </Tabs>
      <MergeDialog worktree={worktree} open={merging} onOpenChange={setMerging} />
      <ReviewTargetDialog
        open={picking}
        onOpenChange={setPicking}
        providers={providers}
        sessions={agent.sessions}
        initialTarget={agent.selected ? { provider: agent.selected.provider, sessionId: agent.selected.sessionId } : undefined}
        count={unsent.length + pickedThreads.size}
        onSend={(target, note) => {
          setPicking(false)
          const notes = threads.filter((thread) => pickedThreads.has(thread.id)).map(threadAsNote)
          setPickedThreads(new Set())
          onSendForReview(target, note, notes)
        }}
      />
      <span className="sr-only">{plural(unsent.length, 'unsent comment')}</span>
    </>
  )
}
