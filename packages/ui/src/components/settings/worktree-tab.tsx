/** Where worktrees are created for this project, and what creates them. */
import { Check, TriangleAlert } from 'lucide-react'

import { renderWorktreePath, type Project, type ProjectSettings } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useHost } from '@/lib/api-hooks'
import { WORKTREE_PATH_VARS } from '@/lib/settings-ui'

import { Row, ScopeNote, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

/** Where a worktree of this project would land, with a placeholder branch. */
function pathExample(template: string, root: string, project: Project): string {
  if (template.trim() === '') return ''
  return renderWorktreePath(template, { root, repo: project.name, repoPath: project.path, name: 'feat-x', branch: 'feat/x' })
}

export function WorktreeTab({ project, draft }: { project: Project; draft: Draft<ProjectSettings> }): React.JSX.Element {
  const host = useHost()
  const tool = host.data?.canopywt
  const worktree = draft.settings?.worktree
  const setWorktree = (patch: Partial<ProjectSettings['worktree']>): void =>
    draft.update((current) => ({ ...current, worktree: { ...current.worktree, ...patch } }))
  const example = worktree && host.data ? pathExample(worktree.worktreePath, host.data.worktreeRoot, project) : ''

  return (
    <div className="flex flex-col gap-5">
      <TabHeader title="Worktrees" description="Where this project's worktrees are created, and what creates them." status={draft.status} />

      <ScopeNote>
        Canopy creates and removes worktrees through <code>canopywt</code> when it is installed, and falls back to plain <code>git worktree</code> otherwise. The tool adds what
        git alone does not: a dirty check that says how much uncommitted work is at stake, a <code>worktree prune</code> after every removal, and a branch-deletion policy.
        Everything this project <em>runs</em> — ports, setup steps, services — lives in <code>canopy.yaml</code> on the YAML tab, so it travels with the branch.
      </ScopeNote>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {tool?.available ? (
          <>
            <Badge variant="outline" className="gap-1 text-[10px] text-nessa-diff-addition">
              <Check className="size-3" /> canopywt {tool.version ?? 'installed'}
            </Badge>
            {tool.path ? <span className="font-mono text-muted-foreground">{tool.path}</span> : null}
          </>
        ) : host.isPending ? (
          <span className="text-muted-foreground">Checking for canopywt…</span>
        ) : (
          <>
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <TriangleAlert className="size-3" /> canopywt not found
            </Badge>
            <span className="text-muted-foreground">
              install: <code className="font-mono text-foreground">cargo install canopy-worktree</code> — until then Canopy uses plain git.
            </span>
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <Row label="Use canopywt" hint="Off drives every worktree through plain git.">
          <Switch
            checked={worktree?.tool ?? false}
            disabled={!worktree}
            onCheckedChange={(checked) => setWorktree({ tool: checked })}
            aria-label="Use canopywt"
          />
        </Row>

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
