import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, GitCommitHorizontal } from 'lucide-react'

import type { Against, ChangedFile, ChangesResponse, ExcludeMethod, ReviewComment, Worktree } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useDiffFiles, useExclude, useStage } from '@/lib/api-hooks'
import { checkStateOf, dirCheckStates, filesUnder, type CheckState } from '@/lib/commit-selection'
import { treeFromPaths, type FlatRow } from '@/lib/file-tree'
import { plural, relativeTime } from '@/lib/format'

import { CommitBox } from './commit-box'
import { DiffExplorer, type ExplorerFocus } from './diff-explorer'
import type { CommitSelection } from './file-tree'
import { HiddenPaths } from './hidden-paths'
import { ReviewToolbar } from './review-toolbar'

/** Stable stand-in while the list is loading, so the memos below do not rebuild every render. */
const EMPTY_FILES: ChangedFile[] = []

/** The extension of the first path, for the "ignore every .ts file" item. */
const extensionOf = (path: string): string | undefined => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : undefined
}

/**
 * Everything the commit panel adds to the Changes view. It exists only for `vs HEAD`: the
 * `vs <base>` comparison resolves to the merge base, so its rows include work that is already
 * committed and a checkbox there would have nothing true to say.
 */
function useCommitPanel(worktreeId: string, changes: ChangesResponse | undefined, enabled: boolean) {
  const stage = useStage(worktreeId)
  const exclude = useExclude(worktreeId)
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string>()

  const files = changes?.files ?? EMPTY_FILES
  const operation = changes?.operation ?? null
  const root = useMemo(() => treeFromPaths(files.map((file) => file.path)), [files])
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
  const fileState = useMemo(
    () => (path: string): CheckState => checkStateOf(byPath.get(path)?.staged ?? 'unstaged'),
    [byPath]
  )
  const dirStates = useMemo(() => dirCheckStates(root, fileState), [root, fileState])

  // `mutate` is stable across renders, unlike the mutation object around it, so the selection
  // below can be memoised: the tree rebuilds a row for every file whenever this identity
  // changes, and without this it would do that on every poll tick and every hover.
  const stageMutate = stage.mutate
  const excludeMutate = exclude.mutate

  const selection = useMemo<CommitSelection>(() => {
    const pathsFor = (row: FlatRow): string[] => (row.kind === 'dir' ? filesUnder(root, row.id) : [row.id])
    /** A row acts on the whole highlight when it is part of it — the usual file-manager rule. */
    const targetsFor = (paths: string[]): string[] => {
      if (!paths.some((path) => highlighted.has(path))) return paths
      return [...new Set([...paths, ...files.map((file) => file.path).filter((path) => highlighted.has(path))])]
    }
    const hide = (paths: string[], how: ExcludeMethod): void => {
      excludeMutate({ paths, how })
    }

    return {
      stateOf: (row) => (row.kind === 'dir' ? dirStates.get(row.id) ?? 'unchecked' : fileState(row.id)),
      onToggle: (paths, checked) => {
        const targets = targetsFor(paths)
        stageMutate(checked ? { stage: targets, unstage: [] } : { stage: [], unstage: targets })
      },
      highlighted,
      onHighlightChange: (next, nextAnchor) => {
        setHighlighted(next)
        setAnchor(nextAnchor)
      },
      anchor,
      pathsFor,
      disabled: operation !== null,
      renderMenu: (paths) => {
        const targets = targetsFor(paths)
        const extension = targets.length === 1 && targets[0] ? extensionOf(targets[0]) : undefined
        const tracked = targets.filter((path) => byPath.get(path)?.status !== 'U')
        return (
          <>
            <ContextMenuItem onSelect={() => stageMutate({ stage: targets, unstage: [] })}>Include in commit</ContextMenuItem>
            <ContextMenuItem onSelect={() => stageMutate({ stage: [], unstage: targets })}>Exclude from commit</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => hide(targets, 'exclude')}>
              Ignore locally <span className="ml-auto pl-2 text-[10px] text-muted-foreground">not committed</span>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => hide(targets, 'gitignore')}>Add to .gitignore</ContextMenuItem>
            {extension ? <ContextMenuItem onSelect={() => hide([`*${extension}`], 'gitignore')}>Add *{extension} to .gitignore</ContextMenuItem> : null}
            {tracked.length > 0 ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => hide(tracked, 'skipWorktree')}>
                  Ignore my local edits <span className="ml-auto pl-2 text-[10px] text-muted-foreground">this worktree</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => hide(tracked, 'untrack')}>
                  Stop tracking <span className="ml-auto pl-2 text-[10px] text-muted-foreground">commits a deletion</span>
                </ContextMenuItem>
              </>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(targets.join('\n'))}>
              Copy {targets.length > 1 ? `${targets.length} paths` : 'path'}
            </ContextMenuItem>
          </>
        )
      }
    }
  }, [anchor, byPath, dirStates, excludeMutate, fileState, files, highlighted, operation, root, stageMutate])

  const allState: CheckState = dirStates.get('') ?? 'unchecked'
  const toggleAll = (): void => {
    const paths = files.map((file) => file.path)
    stageMutate(allState === 'checked' ? { stage: [], unstage: paths } : { stage: paths, unstage: [] })
  }

  if (!enabled || !changes) return undefined
  return { selection, allState, toggleAll, error: stage.error ?? exclude.error }
}

export function ChangesView({
  worktree,
  comments,
  mode,
  onModeChange,
  onSendForReview,
  sending,
  focus
}: {
  worktree: Worktree
  comments: ReviewComment[]
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSendForReview: () => void
  sending: boolean
  focus?: ExplorerFocus
}): React.JSX.Element {
  const [against, setAgainst] = useState<Against>('head')
  const spec = { kind: 'worktree', against } as const
  const changes = useDiffFiles(worktree.id, spec)
  const listed = changes.data as ChangesResponse | undefined
  const files: ChangedFile[] = listed?.files ?? []
  const last = worktree.status?.lastCommit
  const uncommitted = comments.filter((comment) => !comment.commitSha)
  const panel = useCommitPanel(worktree.id, listed, against === 'head')

  return (
    <div className="flex flex-col gap-3">
      <ReviewToolbar files={files} comments={uncommitted} mode={mode} onModeChange={onModeChange} onSendForReview={onSendForReview} sending={sending}>
        <SegmentedControl value={against} onValueChange={(value) => setAgainst(value as Against)} aria-label="Compare against">
          <SegmentedControlOption value="head">vs HEAD</SegmentedControlOption>
          <SegmentedControlOption value="base">vs {worktree.baseBranch}</SegmentedControlOption>
        </SegmentedControl>
        {panel && files.length > 0 ? (
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Checkbox
              checked={panel.allState === 'checked'}
              indeterminate={panel.allState === 'mixed'}
              disabled={panel.selection.disabled}
              onChange={panel.toggleAll}
              className="size-3.5"
              aria-label="Include every changed file in the commit"
            />
            {plural(files.length, 'changed file')}
          </label>
        ) : null}
        {panel ? <HiddenPaths worktreeId={worktree.id} /> : null}
      </ReviewToolbar>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {last ? (
          <span className="flex items-center gap-1">
            <GitCommitHorizontal className="size-3.5" />"{last.subject}" — {last.author}, {relativeTime(last.at)}
          </span>
        ) : null}
        {worktree.status?.ahead !== null && worktree.status?.ahead !== undefined ? (
          <span className="flex items-center gap-0.5">
            <ArrowUp className="size-3" />
            {worktree.status.ahead} ahead
            <ArrowDown className="ml-1.5 size-3" />
            {worktree.status.behind} behind {worktree.baseBranch}
          </span>
        ) : null}
      </div>
      {changes.isPending ? <p className="py-6 text-center font-mono text-xs text-muted-foreground">Reading working tree…</p> : null}
      {changes.error ? <p className="text-xs text-destructive">{changes.error.message}</p> : null}
      {panel?.error ? <p className="text-xs text-destructive">{panel.error.message}</p> : null}
      {changes.data && files.length === 0 && !panel ? (
        <div className="rounded-xl border border-border py-10 text-center text-sm text-muted-foreground">Nothing differs from {worktree.baseBranch}.</div>
      ) : null}
      {/*
        With the commit panel on, the explorer stays mounted even with nothing to show: the commit
        box lives in its footer, and unmounting it the moment the last file is committed would take
        the confirmation away with it.
      */}
      {files.length > 0 || panel ? (
        <DiffExplorer
          worktreeId={worktree.id}
          spec={spec}
          files={files}
          comments={uncommitted}
          mode={mode}
          focus={focus}
          commit={panel?.selection}
          treeFooter={panel ? <CommitBox worktreeId={worktree.id} branch={listed?.branch ?? worktree.branch} files={files} operation={listed?.operation ?? null} /> : undefined}
          className="h-[calc(100vh-330px)] min-h-[420px] overflow-hidden rounded-xl border border-border"
        />
      ) : null}
    </div>
  )
}
