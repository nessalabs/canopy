import { useState } from 'react'
import { GitMerge } from 'lucide-react'

import type { ReviewComment, Worktree } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useComments, useProviders } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import type { ReviewTarget } from '@/lib/use-agent-turn'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { ChangesView } from './changes-view'
import { CommentsPanel } from './comments-panel'
import type { ExplorerFocus } from './diff-explorer'
import { HistoryView } from './history-view'
import { MergeDialog } from './merge-dialog'
import { ReviewTargetDialog } from './review-target-dialog'

type Pane = 'changes' | 'history' | 'comments'

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

/** Git Diff = Changes (working tree) | History (log + per-commit diff) | Comments (everything left on either). */
export function GitDiffTab({ worktree, agent, onSendForReview }: { worktree: Worktree; agent: WorktreeAgent; onSendForReview: (target: ReviewTarget, note: string | undefined) => void }): React.JSX.Element {
  const comments = useComments(worktree.id).data ?? []
  const providers = useProviders().data ?? []
  const [mode, setMode] = useState<DiffMode>('unified')
  const [pane, setPane] = useState<Pane>('changes')
  const [jump, setJump] = useState<Jump>()
  const [picking, setPicking] = useState(false)
  const [merging, setMerging] = useState(false)
  const unsent = comments.filter((c) => !c.sent)
  const ahead = worktree.status?.ahead ?? 0
  const landed = worktree.status?.merged === true
  // Nothing to land: the main checkout, a detached HEAD, a branch with no commits of its own, or one that already landed.
  const mergeable = !worktree.isMain && worktree.branch !== null && ahead > 0 && !landed
  const mergeHint = landed ? `Already merged into ${worktree.baseBranch}` : ahead === 0 ? `No commits ${worktree.baseBranch} lacks` : `Land ${plural(ahead, 'commit')} on ${worktree.baseBranch}`

  const onJump = (comment: ReviewComment): void => {
    const next = jumpFor(comment)
    setJump(next)
    setPane(next.pane)
  }
  const shared = { comments, mode, onModeChange: setMode, onSendForReview: () => setPicking(true), sending: agent.turn.busy }
  const focusFor = (target: Pane): ExplorerFocus | undefined => (jump?.pane === target ? jump.focus : undefined)

  return (
    <>
      <Tabs value={pane} onValueChange={(value) => setPane(value as Pane)} className="flex-1">
        <div className="flex items-center gap-3">
          <TabsList>
            <TabsTrigger value="changes">Changes{worktree.status?.dirtyTotal ? ` · ${worktree.status.dirtyTotal}` : ''}</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="comments">Comments{comments.length ? ` · ${comments.length}` : ''}</TabsTrigger>
          </TabsList>
          {worktree.isMain || worktree.branch === null ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-auto">
                  <Button variant="outline" size="sm" className="h-8" disabled={!mergeable} onClick={() => setMerging(true)}>
                    <GitMerge />
                    {landed ? 'Merged' : `Merge into ${worktree.baseBranch}`}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{mergeHint}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <TabsContent value="changes" className="mt-3 flex min-h-0 flex-1 flex-col">
          <ChangesView worktree={worktree} focus={focusFor('changes')} {...shared} />
        </TabsContent>
        <TabsContent value="history" className="mt-3 flex min-h-0 flex-1 flex-col">
          <HistoryView worktreeId={worktree.id} focusCommit={jump?.commitSha} focus={focusFor('history')} {...shared} />
        </TabsContent>
        <TabsContent value="comments" className="mt-3 overflow-y-auto">
          <CommentsPanel worktreeId={worktree.id} comments={comments} onJump={onJump} />
        </TabsContent>
      </Tabs>
      <MergeDialog worktree={worktree} open={merging} onOpenChange={setMerging} />
      <ReviewTargetDialog
        open={picking}
        onOpenChange={setPicking}
        providers={providers}
        sessions={agent.sessions}
        initialTarget={agent.selected ? { provider: agent.selected.provider, sessionId: agent.selected.sessionId } : undefined}
        count={unsent.length}
        onSend={(target, note) => {
          setPicking(false)
          onSendForReview(target, note)
        }}
      />
      <span className="sr-only">{plural(unsent.length, 'unsent comment')}</span>
    </>
  )
}
