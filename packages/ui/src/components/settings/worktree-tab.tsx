/** Where worktrees are created for this project. */
import { renderWorktreePath, type Project, type ProjectSettings } from '@canopy/shared'

import { Input } from '@/components/ui/input'
import { useHost } from '@/lib/api-hooks'
import { WORKTREE_PATH_VARS } from '@/lib/settings-ui'

import { Row, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

/** Where a worktree of this project would land, with a placeholder branch. */
function pathExample(template: string, root: string, project: Project): string {
  if (template.trim() === '') return ''
  return renderWorktreePath(template, { root, repo: project.name, repoPath: project.path, name: 'feat-x', branch: 'feat/x' })
}

export function WorktreeTab({ project, draft }: { project: Project; draft: Draft<ProjectSettings> }): React.JSX.Element {
  const host = useHost()
  const worktree = draft.settings?.worktree
  const setWorktree = (patch: Partial<ProjectSettings['worktree']>): void =>
    draft.update((current) => ({ ...current, worktree: { ...current.worktree, ...patch } }))
  const example = worktree && host.data ? pathExample(worktree.worktreePath, host.data.worktreeRoot, project) : ''

  return (
    <div className="flex flex-col gap-5">
      <TabHeader title="Worktrees" description="Where this project's worktrees are created." status={draft.status} />

      <div className="flex min-w-0 flex-col gap-5">
        <Row
          label="Worktree location"
          hint="A Canopy template. Canopy renders it and passes the finished path per call. Relative results land under the daemon's worktree root."
        >
          <Input
            className="max-w-lg font-mono text-xs"
            value={worktree?.worktreePath ?? ''}
            disabled={!worktree}
            aria-label="Worktree path template"
            onChange={(event) => setWorktree({ worktreePath: event.target.value })}
          />
          <div className="flex flex-wrap gap-1.5">
            {WORKTREE_PATH_VARS.map((variable) => (
              <button
                key={variable}
                type="button"
                disabled={!worktree}
                className="cursor-pointer rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Append to the template"
                onClick={() => setWorktree({ worktreePath: `${worktree?.worktreePath ?? ''}${variable}` })}
              >
                {variable}
              </button>
            ))}
          </div>
          {example ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              feat/x → <span className="text-foreground">{example}</span>
            </p>
          ) : null}
        </Row>
      </div>
    </div>
  )
}
