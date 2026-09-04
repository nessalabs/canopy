# canopyd REST API (iteration 1)

Base: `http://127.0.0.1:9483/api/v1` · Auth: `Authorization: Bearer $(cat ~/.canopy/token)` on
every route except `GET /healthz` · Errors: `{ "error": { "code", "message", "details?" } }` with
stable snake_case codes (`not_a_git_repo`, `project_exists`, `worktree_dirty`,
`cannot_destroy_main`, `no_comments`, `unauthorized`, `validation_error`, `git_failed`).

Schemas are zod in `packages/shared/src/schemas`; route paths in `packages/shared/src/api/routes.ts`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/healthz` | | `{ ok, version }` |
| GET | `/projects` | | `{ projects: Project[] }` |
| POST | `/projects/scan` | `{ path }` | `ScanResult` |
| POST | `/projects` | `{ path, name?, defaultBase? }` | 201 `{ project }` |
| GET | `/projects/:id` | | `{ project, worktrees }` |
| PATCH | `/projects/:id` | `{ name?, defaultBase? }` | `{ project }` |
| DELETE | `/projects/:id` | | 204 |
| GET | `/projects/:id/branches` | | `{ branches, defaultBranch }` |
| POST | `/projects/:id/worktrees` | `{ name, branch: {mode:'new',name,base} \| {mode:'existing',name} }` | 201 `{ worktree }` |
| GET | `/worktrees` | | `{ worktrees }` |
| GET | `/worktrees/:id` | | `{ worktree }` |
| DELETE | `/worktrees/:id` | `?force=true` | 204 |
| GET | `/worktrees/:id/changes` | `?against=head\|base` | `{ against, rev, baseBranch, files }` |
| GET | `/worktrees/:id/changes/file` | `?against=&path=` | `FilePatch` |
| GET | `/worktrees/:id/tree` | `?path=` (dir, '' = root) | `{ path, entries: [{ name, path, kind }] }` — tracked + untracked, ignore-aware, one directory level |
| GET | `/worktrees/:id/file` | `?path=&rev?=` | `FileContents` — working tree, or the blob at `rev` |
| GET | `/worktrees/:id/log` | `?limit=50&skip=0` | `{ commits, hasMore }` |
| GET | `/worktrees/:id/commits/:sha` | | `{ commit, files }` |
| GET | `/worktrees/:id/trees/:before/:after` | | `{ before, after, files }` — diff between two snapshot trees (see hooks) |
| GET | `/worktrees/:id/trees/:before/:after/file` | `?path=` | `FilePatch` |
| GET | `/worktrees/:id/commits/:sha/file` | `?path=` | `FilePatch` |
| GET | `/worktrees/:id/comments` | | `{ comments }` |
| POST | `/worktrees/:id/comments` | `{ file, line, side, text, code?, commitSha? }` | 201 `{ comment }` |
| DELETE | `/worktrees/:id/comments/:cid` | | 204 |
| POST | `/worktrees/:id/review` | `{ provider, sessionId \| null, commentIds?, note?, autonomy? }` — `null` starts a new session (its id arrives in the `session` event and is pinned) | SSE `AgentStreamEvent` |
| GET | `/worktrees/:id/agent/sessions` | `?limit=25` | `{ sessions, pinned? }` |
| PUT | `/worktrees/:id/agent/pin` | `{ provider, sessionId }` | 204 |
| GET | `/agents/providers` | | `{ providers }` |
| GET | `/agent/sessions/:provider/:sid/edits` | | `{ edits: AgentEdit[] }` — files changed per tool call with before/after trees, recorded by the Claude Code hooks (`npm run hooks:setup`) |
| POST | `/hooks/claude` | Claude Code PreToolUse/PostToolUse payload | `204`; snapshots the worktree containing `cwd` around the call |
| GET | `/agent/sessions/:provider/:sid/transcript` | `?cwd=` | `{ items, model?, effort?, live? }` — tool items that wrote files carry `files: string[]` (absolute paths; edit-tool inputs, or write targets parsed from Bash command text) |
| POST | `/agent/sessions/:provider/:sid/messages` | `{ text, cwd?, autonomy? }` | SSE `AgentStreamEvent` |

SSE streams carry one `data: <json>` frame per event: `session` → `delta`* / `item`* → `done` | `error`.
Closing the connection aborts the agent turn.

`FilePatch.patch` is `null` for binary files and for patches over 512 KiB (`truncated: true`);
`FileContents.content` likewise for binary files and files over 2 MiB. Paths that leave the worktree are `400 bad_path`.
