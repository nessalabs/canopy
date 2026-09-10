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
| POST | `/worktrees/:id/stage` | `{ stage: string[], unstage: string[] }` | `ChangesResponse` — batched checkbox toggles; answers with the refreshed list so the client needs no follow-up read |
| GET | `/worktrees/:id/stage/hunks` | `?path=` | `{ path, patchHash, staged: number[], partial: number[], representable }` — which hunks of a file's HEAD→worktree patch are in the index |
| POST | `/worktrees/:id/stage/hunks` | `{ path, hunks: number[], patchHash }` | `ChangesResponse`; `409 stale_patch` when the file moved under the picks, `409 not_representable` when the index holds content those hunks cannot express |
| POST | `/worktrees/:id/commit` | `{ summary, description?, noVerify? }` | 201 `{ commit }`; `400 nothing_staged`, `409 conflicted`, `409 operation_in_progress` |
| GET | `/worktrees/:id/hidden` | | `{ hidden: [{ path, how }] }` — locally hidden paths; its own read so the changes poll never pays for it |
| POST | `/worktrees/:id/exclude` | `{ paths, how: 'exclude'\|'gitignore'\|'skipWorktree'\|'untrack' }` | `{ hidden }` |
| POST | `/worktrees/:id/unhide` | `{ paths }` | `{ hidden }` — undoes whichever mechanism was hiding each path |
| GET | `/worktrees/:id/comments` | | `{ comments }` |
| POST | `/worktrees/:id/comments` | `{ file, line, side, text, code?, commitSha? }` | 201 `{ comment }` |
| DELETE | `/worktrees/:id/comments/:cid` | | 204 |
| POST | `/worktrees/:id/review` | `{ provider, sessionId \| null, commentIds?, note?, autonomy? }` — `null` starts a new session (its id arrives in the `session` event and is pinned) | SSE `AgentStreamEvent` |
| GET | `/worktrees/:id/agent/sessions` | `?limit=25` | `{ sessions, pinned? }` |
| PUT | `/worktrees/:id/agent/pin` | `{ provider, sessionId }` | 204 |
| GET | `/agents/providers` | | `{ providers }` |
| GET | `/agent/sessions/:provider/:sid/edits` | | `{ edits: AgentEdit[] }` — files changed per tool call with before/after trees, recorded by the Claude Code hooks (`npm run hooks:setup`) |
| POST | `/hooks/claude` | Claude Code PreToolUse/PostToolUse payload | `204`; snapshots the worktree containing `cwd` around the call |
| GET | `/agent/sessions/:provider/:sid/transcript` | `?cwd=` | `TranscriptResponse` — `{ events: AgentEvent[], files: Record<callId, string[]>, extras, model?, effort?, openInTerminal?, nextSeq }`; the normalized agent-stream event log plus the paths each tool call wrote (absolute; edit-tool inputs or Bash write targets) |
| POST | `/agent/sessions/:provider/:sid/messages` | `{ text, cwd?, autonomy? }` | SSE `AgentStreamEvent` |

SSE streams carry one `data: <json>` frame per event: `session` → (`event` | `files` | `progress`)* → `done` | `error`. An `event` frame wraps one agent-stream `AgentEvent`; a `files` frame names the paths a tool call wrote.
Closing the connection aborts the agent turn.

### Staging is the index

The commit panel's checkbox *is* git's index: checked means staged, and `POST /commit` is a plain
`git commit` of it. Nothing is kept beside the index and merged in later, so staging done in a
terminal shows up as a checked (or mixed) box within one poll and is never silently discarded, and
a file left unchecked cannot reach the commit. `ChangedFile` therefore carries `staged`
(`staged | unstaged | partial`), `conflicted`, and the HEAD and index blob ids;
`ChangesResponse` adds `branch` and `operation` (a merge/rebase/cherry-pick/revert in progress,
during which staging individual paths is refused because it can discard a conflict resolution).

Hunk staging rewrites one file's index entry from HEAD plus the chosen hunks, which is only safe
while everything already staged for that file is expressible as those same hunks. The daemon
proves that first by comparing the `-U0` changes of `git diff HEAD` and `git diff --cached HEAD`
(zero context, so git never merges neighbouring hunks and the two are comparable); when they do
not line up it answers `not_representable` rather than guessing.

`hidden` is read separately from the changes list because two of its three mechanisms
(`.git/info/exclude`, `--skip-worktree`) leave no trace in `git status` at all, and collecting it
costs an `ls-files -v` plus two file reads that the 5-second poll should not repeat.

`FilePatch.patch` is `null` for binary files and for patches over 512 KiB (`truncated: true`);
`FileContents.content` likewise for binary files and files over 2 MiB. Paths that leave the worktree are `400 bad_path`.


## Environment & resources (iteration 2)

Schemas in `packages/shared/src/schemas/environment.ts`; design in `docs/plans/environment-and-resources.md`.
Every `Worktree` now carries `environment: WorktreeEnvironment` (state, services, databases, ports, env,
provisioning run). Mutations return `{ environment }`; the event stream carries the follow-up.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/host` | | `HostInfo` — cores, memory, docker/worktrunk availability, port range, `canopyCommand` |
| GET | `/fs/dirs` | `?path=&hidden=1` | `DirListing` — folders then files of a path on the daemon's machine (git repos marked, capped at 2 000 entries with `truncated`), for the Add-project folder picker; 400 `path_not_found` / `not_a_directory`, 403 `path_forbidden` |
| GET | `/events` | `?since=<seq>` | SSE of `CanopyEvent` (`hello`, `reset`, `environment`, `worktree-removed`, `worktrees-changed`, `project-changed`, `resources`, `host`); `: ping` heartbeat every 15 s |
| GET/PATCH | `/settings` | `AppSettingsPatch` | `{ settings: AppSettings }` — editor/terminal commands, diff prefs, port range (this machine) |
| GET/PATCH | `/projects/:id/settings` | `ProjectSettingsPatch` | `{ settings: ProjectSettings, project? }` — worktrunk, copy files, caches, defaults, cleanup |
| GET/PUT | `/projects/:id/config` | `{ raw }` | `{ raw, path, report }` — the primary checkout's canopy.yaml; PUT validates first (400 `invalid_canopy_yaml`) |
| POST | `/projects/:id/config/scaffold` | | `{ raw, report }` — starter canopy.yaml from repo detection |
| GET | `/projects/:id/environment` | | `ProjectEnvironmentPreview` — services/ports/databases/setup, detected caches and copy candidates |
| GET/POST | `/projects/:id/wt-toml` | | `{ toml, path, inSync, exists }` — rendered `.config/wt.toml`; POST writes it |
| POST | `/projects/:id/databases/:name/refresh` | | 204 — re-seed the shared template |
| POST | `/projects/:id/stop` | | 204 |
| POST | `/projects/:id/destroy-worktrees` | `{ force?, deleteBranch? }` | 204 |
| POST | `/projects/:id/worktrees` | `CreateWorktreeInput` + `provision?`, `autoStart?`, `options?` | 201 `{ worktree }` in state `creating`; the pipeline runs in the background |
| POST | `/worktrees/adopt` | `{ path, autoStart? }` | 201 `{ worktree }` — provision a worktree created outside Canopy (used by `canopy provision`) |
| DELETE | `/worktrees/:id` | `?force=true&deleteBranch=true|false` | 204 — tears down services/forks/ports, then `wt remove` / `git worktree remove` |
| GET | `/worktrees/:id/environment` | | `{ environment }` |
| POST | `/worktrees/:id/start` · `/stop` · `/restart` | | `{ environment }` |
| POST | `/worktrees/:id/provision` | `ProvisionInput` (`from?`, `options?`, `autoStart?`) | `{ environment }` — resume/re-run the pipeline from a step |
| POST | `/worktrees/:id/env-file` | | `{ environment }` — regenerate the dotenv |
| POST | `/worktrees/:id/open` | `{ target: editor|terminal, file?, line? }` | `{ command }` |
| GET | `/worktrees/:id/resources` | | `{ samples: ResourceSample[], host: HostSample[] }` |
| POST | `/worktrees/:id/services/:name/start|stop|restart` | | `{ environment }` |
| GET | `/worktrees/:id/services/:name/logs` | `?since=&limit=` or `&follow=1` | `LogsResponse`, or SSE of `LogEvent` (`line`, `reset`, `end`). Built-in streams: `provision`, `supervisor` |
| POST | `/worktrees/:id/databases/:name/reset` | `{ from?: template | empty | { fromWorktree } }` | `{ environment }` |

New error codes: `worktree_create_failed`, `already_provisioning`, `destroying`, `busy`, `no_canopy_yaml`,
`invalid_canopy_yaml`, `unknown_worktree`, `no_free_port`, `db_<adapter>_failed`, `no_launch_command`, `bad_port_range`.

The hook-facing CLI `packages/daemon/bin/canopy.mjs` (`canopy provision|teardown|forget|start|stop|status`) drives
these routes from worktrunk hooks; it exits 0 when the daemon is down and no-ops when `CANOPY_DAEMON=1`.
