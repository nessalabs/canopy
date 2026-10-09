import { useMemo, useRef, useState } from 'react'

import type { Against, GitHubNote, GitHubThread, ReviewComment, Worktree } from '@canopy/shared'

import { SelectionActions } from '@/components/agent/selection-actions'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import type { DiffMode } from '@/components/worktree-diff'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { toStaged } from '@/lib/agent-context'
import { useComments, useDiffFiles, usePrefetchPullRequest, useProviders, usePullRequest, usePullRequestThreads, useWorktreeFiles } from '@/lib/api-hooks'
import { reviewedKey, reviewSections } from '@/lib/change-groups'
import { snippetSource, useSnippetDrag } from '@/lib/dom-selection'
import { parseFileRef, resolvePath } from '@/lib/file-refs'
import { plural } from '@/lib/format'
import { GIT_PANES, linkQuery, parseGitLink, type GitPane } from '@/lib/environment-ui'
import type { ReviewTarget } from '@/lib/use-agent-turn'
import { useChangeGroups } from '@/lib/use-change-groups'
import { useGitAgent } from '@/lib/use-git-agent'
import { useHotkeys } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { ChangesView } from './changes-view'
import { CommentsPanel } from './comments-panel'
import type { ExplorerFocus } from './diff-explorer'
import { setDragChip } from './git-agent/drag-chip'
import { GitAgentPanel } from './git-agent/panel'
import { GitAgentToggle } from './git-agent/status'
import { DiffTools, GitActions, GitViewTabs } from './git-chrome'
import { HistoryView } from './history-view'
import { MergeDialog } from './merge-dialog'
import { PullRequestView } from './pull-request-view'
import { GroupsView } from './groups-view'
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
 * Git = Changes (working tree) | Groups (the same change, feature by feature) | History (log + per-commit diff) | Pull request (the branch's PR
 * on GitHub) | Comments (everything left on Changes or History). Its tabs, diff switches and
 * primary action live in the top bar; the pane below starts at its content. The Git Agent docks
 * to the right of every pane: comments sent for review go to it, and so does anything
 * highlighted or dragged out of a pane.
 */
export function GitTab({
  worktree,
  agent,
  pane,
  onPaneChange
}: {
  worktree: Worktree
  /** The worktree's sessions, offered as review destinations. */
  agent: WorktreeAgent
  pane: Pane
  onPaneChange: (pane: Pane) => void
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
  const gitAgent = useGitAgent(worktree.id)
  const agentSeed = `git-agent:${worktree.id}`
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
  // Groups reads the same diff Changes lists, and its tab counts the sections still to review.
  const changeGroups = useChangeGroups(worktree, against, gitAgent)
  const diff = useDiffFiles(worktree.id, { kind: 'worktree', against }).data
  const unreviewed = useMemo(
    () => (changeGroups.result ? reviewSections(changeGroups.result.groups).filter((section) => !changeGroups.reviewed.has(reviewedKey(section.refs))).length : 0),
    [changeGroups.result, changeGroups.reviewed]
  )

  // Code highlighted or dragged out of any pane reaches the agent with its file and lines.
  const panes = useRef<HTMLDivElement>(null)
  useSnippetDrag(panes, setDragChip)
  const askAgent = (text: string, range: Range): void => gitAgent.ask(toStaged({ kind: 'snippet', text, ...snippetSource(range) }))

  /** `local` sends every unsent comment too; one GitHub comment sent on its own leaves them be. */
  const sendForReview = (target: ReviewTarget, note: string | undefined, github: GitHubNote[], local: boolean): void => {
    const sent = local ? unsent : []
    const what = [sent.length ? plural(sent.length, 'comment') : '', github.length ? plural(github.length, 'GitHub comment') : ''].filter(Boolean).join(' and ')
    gitAgent.sendReview({
      target,
      request: { commentIds: sent.map((c) => c.id), github: github.length ? github : undefined, note },
      summary: `Review request: ${what} on ${worktree.branch ?? worktree.name}`
    })
  }
  const reviewQueued = Object.values(gitAgent.outbox).some((out) => out.kind === 'review')

  // A file the agent cited opens where it is being read: the PR's files on the PR pane, else Changes,
  // which shows a file outside the change set whole. `routes/agents.ts` resolves to its full path.
  const tracked = useWorktreeFiles(worktree.id, gitAgent.open).data?.paths
  const openRef = (href: string): boolean => {
    const ref = parseFileRef(href, worktree.path)
    if (!ref) return false
    const focus: ExplorerFocus = { path: resolvePath(ref.path, tracked ?? []), ...(ref.lines ? { lines: ref.lines } : {}) }
    if (pane === 'pr') setPrFocus(focus)
    else {
      setJump({ pane: 'changes', focus })
      onPaneChange('changes')
    }
    return true
  }
  const focusFor = (target: Pane): ExplorerFocus | undefined => (jump?.pane === target ? jump.focus : undefined)

  return (
    <SendToAgentProvider value={sendOne}>
      <Tabs value={pane} onValueChange={(value) => onPaneChange(value as Pane)} className="flex min-h-0 flex-1 flex-col">
        <GitViewTabs dirty={worktree.status?.dirtyTotal ?? 0} comments={comments.length} unreviewed={unreviewed} onPrefetchPr={prefetchPr} />
        {pane === 'comments' ? null : <DiffTools mode={mode} onModeChange={setMode} against={pane === 'changes' || pane === 'groups' ? against : undefined} onAgainstChange={setAgainst} baseBranch={worktree.baseBranch} />}
        <GitActions
          worktree={worktree}
          pane={pane}
          onPaneChange={onPaneChange}
          mode={mode}
          onModeChange={setMode}
          against={against}
          onAgainstChange={setAgainst}
          pendingReview={unsent.length + pickedThreads.size}
          sending={reviewQueued}
          onSendForReview={sendPicked}
          onMerge={() => setMerging(true)}
          prUrl={prQuery.data?.pr?.url}
          agentToggle={<GitAgentToggle seed={agentSeed} status={gitAgent.status} open={gitAgent.open} onToggle={() => gitAgent.setOpen(!gitAgent.open)} />}
        />
        {/* The agent stays mounted while closed, so its tabs keep streaming and their states keep showing on the toggle. */}
        <SplitView orientation={SplitViewOrientation.Horizontal} className="min-h-0 flex-1">
          <SplitViewPanel id="git-panes" minSize={40} className="min-h-0">
            <div ref={panes} className="flex h-full min-h-0 flex-col">
              <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
                <ChangesView worktree={worktree} focus={focusFor('changes')} against={against} {...shared} />
              </TabsContent>
              <TabsContent value="groups" className="flex min-h-0 flex-1 flex-col">
                <GroupsView worktreeId={worktree.id} against={against} files={diff?.files ?? []} groups={changeGroups} comments={comments} mode={mode} onOpenRef={openRef} />
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
                  <GitHubThreadsPanel number={threadsQuery.data.number} threads={threads} host={host} picked={pickedThreads} onPick={pickThread} onJump={onJumpThread} onSend={sendPicked} sending={reviewQueued} />
                ) : null}
              </TabsContent>
            </div>
            <SelectionActions host={panes} onAsk={askAgent} askLabel="Ask Git Agent" />
          </SplitViewPanel>
          <SplitViewSeparator className={gitAgent.open ? undefined : 'hidden'} />
          <SplitViewPanel id="git-agent" defaultSize={30} minSize={20} className={cn('min-h-0 border-l border-border', !gitAgent.open && 'hidden')}>
            <GitAgentPanel worktree={worktree} agent={gitAgent} seed={agentSeed} onOpenRef={openRef} />
          </SplitViewPanel>
        </SplitView>
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
          sendForReview(target, note, request.github, request.local)
        }}
      />
    </SendToAgentProvider>
  )
}
