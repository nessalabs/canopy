import { ApiError, ApiErrorBody } from '../api/errors'
import { routes } from '../api/routes'
import type {
  AdoptWorktreeInput,
  AgentCapabilities,
  AgentEditsResponse,
  AppSettings,
  AppSettingsPatch,
  CanopyEvent,
  CanopyYamlReport,
  DbResetInput,
  DestroyAllInput,
  DestroyJob,
  DestroyResult,
  StartDestroyJobInput,
  TrashEntry,
  DirListing,
  HostInfo,
  LogEvent,
  LogsResponse,
  OpenInput,
  ProjectEnvironmentPreview,
  ProjectSettings,
  ProjectSettingsPatch,
  ProvisionInput,
  QueueMessageInput,
  ResourcesResponse,
  RewindInput,
  RewindResult,
  ServiceAction,
  WorktreeEnvironment,
  TreesResponse,
  AddCommentInput,
  AddProjectInput,
  AgentProvider,
  AgentStreamEvent,
  Against,
  Branch,
  RemoteBranchList,
  ChangesResponse,
  Commit,
  CommitInput,
  DraftInput,
  TextDraft,
  MergeInput,
  MergeResult,
  CreatePullRequestInput,
  PullRequest,
  PullRequestAction,
  PullRequestActionResult,
  PullRequestOptions,
  PullRequestThreadsResponse,
  PullRequestResponse,
  ProjectPullRequests,
  PushResult,
  CommitResponse,
  ExcludeInput,
  HiddenResponse,
  HunkStatesResponse,
  StageHunksInput,
  StageInput,
  UnhideInput,
  CreateWorktreeInput,
  DiffSpec,
  FileContents,
  FilePatch,
  LiveControlsInput,
  LogResponse,
  NewSessionInput,
  PermissionDecisionInput,
  Project,
  ReviewComment,
  ReviewRequest,
  ScanResult,
  SendMessageInput,
  SessionRef,
  SessionsResponse,
  TranscriptResponse,
  TreeResponse,
  UpdateProjectInput,
  Worktree
} from '../schemas'
import { CanopyEvent as CanopyEventSchema, LogEvent as LogEventSchema } from '../schemas/environment'
import { readSse, readSseWith } from './sse'

export interface ClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

type Query = Record<string, string | number | undefined>

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text()
  const parsed = ApiErrorBody.safeParse(text ? JSON.parse(text) : undefined)
  return parsed.success
    ? new ApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details)
    : new ApiError(response.status, 'http_error', text || response.statusText)
}

/** Split a DiffSpec into the route + query the daemon expects; the one place this mapping lives. */
type DiffTarget = { files: string; file: string; query: Query }

/** Route pair per DiffSpec kind. */
const DIFF_TARGETS: { [K in DiffSpec['kind']]: (worktreeId: string, spec: Extract<DiffSpec, { kind: K }>) => DiffTarget } = {
  worktree: (id, spec) => ({ files: routes.changes(id), file: routes.changesFile(id), query: { against: spec.against } }),
  commit: (id, spec) => ({ files: routes.commit(id, spec.sha), file: routes.commitFile(id, spec.sha), query: {} }),
  trees: (id, spec) => ({ files: routes.trees(id, spec.before, spec.after), file: routes.treesFile(id, spec.before, spec.after), query: {} })
}

const diffTarget = (worktreeId: string, spec: DiffSpec): DiffTarget =>
  (DIFF_TARGETS[spec.kind] as (id: string, spec: DiffSpec) => DiffTarget)(worktreeId, spec)

export type CanopyClient = ReturnType<typeof createClient>

export function createClient({ baseUrl, token, fetch: fetchImpl = fetch }: ClientOptions) {
  const base = baseUrl.replace(/\/$/, '')

  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal
    })
    if (!response.ok) throw await toApiError(response)
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  const get = <T>(path: string, query?: Query) => request<T>('GET', withQuery(path, query))
  const post = <T>(path: string, body: unknown) => request<T>('POST', path, body)
  const del = <T = void>(path: string, query?: Query) => request<T>('DELETE', withQuery(path, query))

  /** A turn's events: POST starts one with `body`; without a body it GETs (follows) one already running. */
  async function* stream(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    const response = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    })
    if (!response.ok) throw await toApiError(response)
    yield* readSse(response)
  }

  /** GET-based SSE for long-lived subscriptions (events, log follow). */
  async function* subscribe<T>(path: string, query: Query, parse: (raw: unknown) => T | undefined, signal?: AbortSignal): AsyncGenerator<T> {
    const response = await fetchImpl(`${base}${withQuery(path, query)}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal })
    if (!response.ok) throw await toApiError(response)
    yield* readSseWith(response, parse)
  }
  const parseWith = <T>(schema: { safeParse: (raw: unknown) => { success: boolean; data?: T } }) => (raw: unknown): T | undefined => {
    const parsed = schema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }
  const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body)

  return {
    baseUrl: base,
    health: () => request<{ ok: boolean; version: string }>('GET', routes.healthz()),

    listProjects: () => get<{ projects: Project[] }>(routes.projects()).then((r) => r.projects),
    scanProject: (path: string) => post<ScanResult>(routes.scanProject(), { path }),
    addProject: (input: AddProjectInput) => post<{ project: Project }>(routes.projects(), input).then((r) => r.project),
    getProject: (id: string) => get<{ project: Project; worktrees: Worktree[] }>(routes.project(id)),
    updateProject: (id: string, input: UpdateProjectInput) =>
      request<{ project: Project }>('PATCH', routes.project(id), input).then((r) => r.project),
    removeProject: (id: string) => del(routes.project(id)),
    listBranches: (id: string) => get<{ branches: Branch[]; defaultBranch: string }>(routes.branches(id)),
    listRemoteBranches: (id: string) => get<RemoteBranchList>(routes.remoteBranches(id)),

    createWorktree: (projectId: string, input: CreateWorktreeInput) =>
      post<{ worktree: Worktree }>(routes.projectWorktrees(projectId), input).then((r) => r.worktree),
    listWorktrees: () => get<{ worktrees: Worktree[] }>(routes.worktrees()).then((r) => r.worktrees),
    getWorktree: (id: string) => get<{ worktree: Worktree }>(routes.worktree(id)).then((r) => r.worktree),
    destroyWorktree: (id: string, force = false) => del<DestroyResult>(routes.worktree(id), { force: force ? 'true' : undefined }),
    /** Answers as soon as the job is queued; its progress arrives as `destroy-job` events. */
    startDestroyJob: (input: StartDestroyJobInput) => post<{ job: DestroyJob }>(routes.destroyJobs(), input).then((r) => r.job),
    destroyJobs: () => get<{ jobs: DestroyJob[] }>(routes.destroyJobs()).then((r) => r.jobs),

    /** Files changed for a DiffSpec — working tree vs HEAD/base, or one commit. */
    diffFiles: (worktreeId: string, spec: DiffSpec) => {
      const target = diffTarget(worktreeId, spec)
      return get<ChangesResponse | CommitResponse | TreesResponse>(target.files, target.query)
    },
    filePatch: (worktreeId: string, spec: DiffSpec, path: string) => {
      const target = diffTarget(worktreeId, spec)
      return get<FilePatch>(target.file, { ...target.query, path })
    },
    /** Immediate children of a directory in the working tree (tracked + untracked, ignore-aware). */
    tree: (worktreeId: string, path = '') => get<TreeResponse>(routes.tree(worktreeId), { path }),
    worktreeFiles: (worktreeId: string) => get<{ paths: string[]; truncated: boolean }>(routes.files(worktreeId)),
    /** A file's contents from the working tree, or from `rev` when given. */
    fileContents: (worktreeId: string, path: string, rev?: string) => get<FileContents>(routes.file(worktreeId), { path, rev }),
    log: (worktreeId: string, limit: number, skip: number) => get<LogResponse>(routes.log(worktreeId), { limit, skip }),

    /** Stage/unstage a batch of paths; the answer is the whole refreshed list, so no refetch. */
    stage: (worktreeId: string, input: StageInput) => post<ChangesResponse>(routes.stage(worktreeId), input),
    /** Which hunks of a file's HEAD→worktree patch are currently in the index. */
    hunkStates: (worktreeId: string, path: string) => get<HunkStatesResponse>(routes.stageHunks(worktreeId), { path }),
    stageHunks: (worktreeId: string, input: StageHunksInput) => post<ChangesResponse>(routes.stageHunks(worktreeId), input),
    commitChanges: (worktreeId: string, input: CommitInput) =>
      post<{ commit: Commit }>(routes.commitChanges(worktreeId), input).then((r) => r.commit),
    draft: (worktreeId: string, input: DraftInput) => post<TextDraft>(routes.draft(worktreeId), input),
    mergeWorktree: (worktreeId: string, input: MergeInput) => post<MergeResult>(routes.merge(worktreeId), input),
    pullRequest: (worktreeId: string, fresh = false) => get<PullRequestResponse>(routes.pullRequest(worktreeId), fresh ? { fresh: '1' } : {}),
    projectPullRequests: (projectId: string) => get<ProjectPullRequests>(routes.projectPullRequests(projectId)),
    createPullRequest: (worktreeId: string, input: CreatePullRequestInput) =>
      post<{ pr: PullRequest }>(routes.pullRequest(worktreeId), input).then((r) => r.pr),
    pullRequestAction: (worktreeId: string, action: PullRequestAction) => post<PullRequestActionResult>(routes.pullRequestAction(worktreeId), action),
    pullRequestOptions: (worktreeId: string) => get<PullRequestOptions>(routes.pullRequestOptions(worktreeId)),
    pullRequestThreads: (worktreeId: string) => get<PullRequestThreadsResponse>(routes.pullRequestThreads(worktreeId)),
    fetchPullRequest: (worktreeId: string) => post<{ fetched: number }>(routes.pullRequestFetch(worktreeId), {}),
    pushBranch: (worktreeId: string) => post<PushResult>(routes.push(worktreeId), {}),
    excludePaths: (worktreeId: string, input: ExcludeInput) => post<ChangesResponse>(routes.exclude(worktreeId), input),
    hiddenPaths: (worktreeId: string) => get<HiddenResponse>(routes.hidden(worktreeId)).then((r) => r.hidden),
    unhidePaths: (worktreeId: string, input: UnhideInput) => post<ChangesResponse>(routes.unhide(worktreeId), input),

    listComments: (worktreeId: string) =>
      get<{ comments: ReviewComment[] }>(routes.comments(worktreeId)).then((r) => r.comments),
    addComment: (worktreeId: string, input: AddCommentInput) =>
      post<{ comment: ReviewComment }>(routes.comments(worktreeId), input).then((r) => r.comment),
    deleteComment: (worktreeId: string, commentId: string) => del(routes.comment(worktreeId, commentId)),

    providers: () => get<{ providers: AgentProvider[] }>(routes.providers()).then((r) => r.providers),
    agentSessions: (worktreeId: string, limit = 25) => get<SessionsResponse>(routes.agentSessions(worktreeId), { limit }),
    pinSession: (worktreeId: string, ref: SessionRef) => request<void>('PUT', routes.agentPin(worktreeId), ref),
    transcript: (ref: SessionRef, cwd?: string) => get<TranscriptResponse>(routes.transcript(ref.provider, ref.sessionId), { cwd }),
    /** Snapshot-backed edits recorded by hooks for a session. */
    agentEdits: (ref: SessionRef) => get<AgentEditsResponse>(routes.agentEdits(ref.provider, ref.sessionId)).then((r) => r.edits),
    streamMessage: (ref: SessionRef, input: SendMessageInput, signal?: AbortSignal) =>
      stream(routes.messages(ref.provider, ref.sessionId), input, signal),
    /** Starts a new session in the worktree with this first message; the `session` event names it. */
    streamNewSession: (worktreeId: string, input: NewSessionInput, signal?: AbortSignal) =>
      stream(routes.agentSessions(worktreeId), input, signal),
    streamReview: (worktreeId: string, input: ReviewRequest, signal?: AbortSignal) =>
      stream(routes.review(worktreeId), input, signal),
    /** Rejoins the turn running in `ref`: everything it produced so far, then live. 404 when none is. */
    followTurn: (ref: SessionRef, signal?: AbortSignal) => stream(routes.liveTurn(ref.provider, ref.sessionId), undefined, signal),
    /** Answers a tool-permission ask (`permission_requested`) of the turn running in `ref`. */
    answerPermission: (ref: SessionRef, input: PermissionDecisionInput) => post<void>(routes.permissions(ref.provider, ref.sessionId), input),
    /** What a session of `provider` in this worktree can do; `sessionId` reads as of that session where supported. */
    agentCapabilities: (worktreeId: string, provider: AgentProvider, opts: { sessionId?: string; refresh?: boolean } = {}) =>
      get<AgentCapabilities>(routes.agentCapabilities(worktreeId), { provider, session: opts.sessionId, refresh: opts.refresh ? 1 : undefined }),
    /** Interrupts the turn running in `ref`; its stream ends with what the agent got done. 404 when nothing is running. */
    interruptTurn: (ref: SessionRef) => post<void>(routes.interrupt(ref.provider, ref.sessionId), {}),
    /** Queues a prompt into the turn running in `ref`. 404 when nothing is running. */
    queueMessage: (ref: SessionRef, input: QueueMessageInput) => post<void>(routes.queue(ref.provider, ref.sessionId), input),
    /** Restores files to before a user message of `ref`; `dryRun` only reports what would change. */
    rewindFiles: (ref: SessionRef, input: RewindInput) => post<RewindResult>(routes.rewind(ref.provider, ref.sessionId), input),
    /** Changes the running turn's model / access mode from its next model call on. 404 when nothing is running. */
    updateLiveControls: (ref: SessionRef, input: LiveControlsInput) => request<void>('PATCH', routes.liveControls(ref.provider, ref.sessionId), input),

    // ---- environment & resources ----
    host: () => get<HostInfo>(routes.host()),
    /** Directories under `path` (default: the daemon user's home). */
    listDirs: (path?: string, hidden = false) => get<DirListing>(routes.fsDirs(), { path, hidden: hidden ? 1 : undefined }),
    /** Live environment/resource events; resumes from `since` when the daemon still has it. */
    events: (since: number | undefined, signal?: AbortSignal) => subscribe(routes.events(), { since }, parseWith<CanopyEvent>(CanopyEventSchema), signal),
    appSettings: () => get<{ settings: AppSettings }>(routes.appSettings()).then((r) => r.settings),
    updateAppSettings: (patch: AppSettingsPatch) => request<{ settings: AppSettings }>('PATCH', routes.appSettings(), patch).then((r) => r.settings),
    projectSettings: (id: string) => get<{ settings: ProjectSettings }>(routes.projectSettings(id)).then((r) => r.settings),
    updateProjectSettings: (id: string, patch: ProjectSettingsPatch) =>
      request<{ settings: ProjectSettings; project: Project }>('PATCH', routes.projectSettings(id), patch),
    projectConfig: (id: string) => get<{ raw: string | null; path: string; report: CanopyYamlReport }>(routes.projectConfig(id)),
    writeProjectConfig: (id: string, raw: string) => put<{ raw: string; report: CanopyYamlReport; project: Project }>(routes.projectConfig(id), { raw }),
    scaffoldProjectConfig: (id: string) => post<{ raw: string; report: CanopyYamlReport }>(routes.projectConfigScaffold(id), {}),
    projectEnvironment: (id: string) => get<ProjectEnvironmentPreview>(routes.projectEnvironment(id)),
    /** Rendered `.config/wt.toml` (preview) and whether it matches the file in the repo. */
    refreshProjectDatabase: (id: string, db: string) => post<void>(routes.projectDbRefresh(id, db), {}),
    stopAllWorktrees: (id: string) => post<void>(routes.projectStopAll(id), {}),
    destroyAllWorktrees: (id: string, input: DestroyAllInput) => post<void>(routes.projectDestroyAll(id), input),
    adoptWorktree: (input: AdoptWorktreeInput) => post<{ worktree: Worktree }>(routes.adoptWorktree(), input).then((r) => r.worktree),
    destroyWorktreeWith: (id: string, opts: { force?: boolean; deleteBranch?: boolean }) =>
      del<DestroyResult>(routes.worktree(id), { force: opts.force ? 'true' : undefined, deleteBranch: opts.deleteBranch === undefined ? undefined : String(opts.deleteBranch) }),
    projectTrash: (id: string) => get<{ entries: TrashEntry[] }>(routes.projectTrash(id)).then((r) => r.entries),
    restoreFromTrash: (id: string, entry: string) => post<{ worktree: Worktree; restored: number }>(routes.trashRestore(id, entry), {}),
    purgeFromTrash: (id: string, entry: string) => del(routes.trashEntry(id, entry)),
    worktreeEnvironment: (id: string) => get<{ environment: WorktreeEnvironment }>(routes.worktreeEnvironment(id)).then((r) => r.environment),
    startWorktree: (id: string) => post<{ environment: WorktreeEnvironment }>(routes.worktreeStart(id), {}).then((r) => r.environment),
    stopWorktree: (id: string) => post<{ environment: WorktreeEnvironment }>(routes.worktreeStop(id), {}).then((r) => r.environment),
    restartWorktree: (id: string) => post<{ environment: WorktreeEnvironment }>(routes.worktreeRestart(id), {}).then((r) => r.environment),
    provisionWorktree: (id: string, input: ProvisionInput) => post<{ environment: WorktreeEnvironment }>(routes.worktreeProvision(id), input).then((r) => r.environment),
    teardownWorktree: (id: string) => post<{ environment: WorktreeEnvironment }>(routes.worktreeTeardown(id), {}).then((r) => r.environment),
    regenerateEnvFile: (id: string) => post<{ environment: WorktreeEnvironment }>(routes.worktreeEnvFile(id), {}).then((r) => r.environment),
    openWorktree: (id: string, input: OpenInput) => post<{ command: string }>(routes.worktreeOpen(id), input),
    worktreeResources: (id: string) => get<ResourcesResponse>(routes.worktreeResources(id)),
    serviceAction: (id: string, name: string, action: ServiceAction) =>
      post<{ environment: WorktreeEnvironment }>(routes.serviceAction(id, name, action), {}).then((r) => r.environment),
    serviceLogs: (id: string, name: string, since?: number, limit?: number) => get<LogsResponse>(routes.serviceLogs(id, name), { since, limit }),
    /** Follows a service log from `since` (offset); ends when the service log is closed. */
    followServiceLogs: (id: string, name: string, since: number | undefined, signal?: AbortSignal) =>
      subscribe(routes.serviceLogs(id, name), { since, follow: 1 }, parseWith<LogEvent>(LogEventSchema), signal),
    resetDatabase: (id: string, name: string, input: DbResetInput = {}) =>
      post<{ environment: WorktreeEnvironment }>(routes.databaseReset(id, name), input).then((r) => r.environment)
  }
}

export type { Against }
