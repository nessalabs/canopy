import { API_PREFIX } from '@canopy/shared'

import { useApi } from '@/providers/api'

const ROUTES: Array<[string, string, string]> = [
  ['GET', '/healthz', 'Liveness; the only unauthenticated route'],
  ['GET', '/projects', 'Registered projects'],
  ['POST', '/projects/scan', 'Inspect a repo path before registering it'],
  ['POST', '/projects', 'Register a repo { path, name?, defaultBase? }'],
  ['GET', '/projects/:id', 'Project with its worktrees'],
  ['PATCH', '/projects/:id', 'Rename / change default base'],
  ['DELETE', '/projects/:id', 'Unregister (disk untouched)'],
  ['GET', '/projects/:id/branches', 'Local branches'],
  ['POST', '/projects/:id/worktrees', 'Create a worktree { name, branch: { mode, name, base? } }'],
  ['GET', '/worktrees', 'Every worktree across projects, with git status'],
  ['GET', '/worktrees/:id', 'One worktree'],
  ['DELETE', '/worktrees/:id?force=true', 'Remove the worktree (409 when dirty unless forced)'],
  ['GET', '/worktrees/:id/changes?against=head|base', 'Changed files in the working tree'],
  ['GET', '/worktrees/:id/changes/file?against=&path=', 'Unified patch for one file'],
  ['GET', '/worktrees/:id/log?limit=&skip=', 'Commit history, paged'],
  ['GET', '/worktrees/:id/commits/:sha', 'One commit with its changed files'],
  ['GET', '/worktrees/:id/commits/:sha/file?path=', 'Patch for one file of a commit'],
  ['GET/POST', '/worktrees/:id/comments', 'Review comments on the diff'],
  ['DELETE', '/worktrees/:id/comments/:cid', 'Delete an unsent comment'],
  ['POST', '/worktrees/:id/review', 'Send unsent comments to an agent session (SSE)'],
  ['GET', '/worktrees/:id/agent/sessions', 'Claude Code / Codex sessions that ran in this checkout'],
  ['PUT', '/worktrees/:id/agent/pin', 'Remember which session reviews go to'],
  ['GET', '/agents/providers', 'Which agent CLIs this host has'],
  ['GET', '/agent/sessions/:provider/:sid/transcript', 'Replay a session'],
  ['POST', '/agent/sessions/:provider/:sid/messages', 'Resume a session with a message (SSE)']
]

export function DocsScreen(): React.JSX.Element {
  const api = useApi()
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">canopyd API</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Base URL <span className="font-mono">{api.baseUrl + API_PREFIX}</span>. Every route takes <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>; errors are{' '}
          <span className="font-mono">{'{ error: { code, message, details? } }'}</span>.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Method</th>
              <th className="px-3 py-2 font-medium">Path</th>
              <th className="px-3 py-2 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {ROUTES.map(([method, path, purpose]) => (
              <tr key={method + path}>
                <td className="px-3 py-1.5 font-mono text-xs">{method}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{path}</td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">{purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
