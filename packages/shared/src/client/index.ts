import { ApiError, ApiErrorBody } from '../api/errors'
import { routes } from '../api/routes'
import type {
  AgentEditsResponse,
  TreesResponse,
  AddCommentInput,
  AddProjectInput,
  AgentProvider,
  AgentStreamEvent,
  Against,
  Branch,
  ChangesResponse,
  CommitResponse,
  CreateWorktreeInput,
  DiffSpec,
  FileContents,
  FilePatch,
  LogResponse,
  NewSessionInput,
  Project,
  ReviewComment,
  ReviewRequest,
  ScanResult,
  SendMessageInput,
  SessionRef,
  SessionsResponse,
  Transcript,
  TreeResponse,
  UpdateProjectInput,
  Worktree
} from '../schemas'
import { readSse } from './sse'

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
  const del = (path: string, query?: Query) => request<void>('DELETE', withQuery(path, query))

  async function* stream(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
    if (!response.ok) throw await toApiError(response)
    yield* readSse(response)
  }

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

    createWorktree: (projectId: string, input: CreateWorktreeInput) =>
      post<{ worktree: Worktree }>(routes.projectWorktrees(projectId), input).then((r) => r.worktree),
    listWorktrees: () => get<{ worktrees: Worktree[] }>(routes.worktrees()).then((r) => r.worktrees),
    getWorktree: (id: string) => get<{ worktree: Worktree }>(routes.worktree(id)).then((r) => r.worktree),
    destroyWorktree: (id: string, force = false) => del(routes.worktree(id), { force: force ? 'true' : undefined }),

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
    /** A file's contents from the working tree, or from `rev` when given. */
    fileContents: (worktreeId: string, path: string, rev?: string) => get<FileContents>(routes.file(worktreeId), { path, rev }),
    log: (worktreeId: string, limit: number, skip: number) => get<LogResponse>(routes.log(worktreeId), { limit, skip }),

    listComments: (worktreeId: string) =>
      get<{ comments: ReviewComment[] }>(routes.comments(worktreeId)).then((r) => r.comments),
    addComment: (worktreeId: string, input: AddCommentInput) =>
      post<{ comment: ReviewComment }>(routes.comments(worktreeId), input).then((r) => r.comment),
    deleteComment: (worktreeId: string, commentId: string) => del(routes.comment(worktreeId, commentId)),

    providers: () => get<{ providers: AgentProvider[] }>(routes.providers()).then((r) => r.providers),
    agentSessions: (worktreeId: string, limit = 25) => get<SessionsResponse>(routes.agentSessions(worktreeId), { limit }),
    pinSession: (worktreeId: string, ref: SessionRef) => request<void>('PUT', routes.agentPin(worktreeId), ref),
    transcript: (ref: SessionRef, cwd?: string) => get<Transcript>(routes.transcript(ref.provider, ref.sessionId), { cwd }),
    /** Snapshot-backed edits recorded by hooks for a session. */
    agentEdits: (ref: SessionRef) => get<AgentEditsResponse>(routes.agentEdits(ref.provider, ref.sessionId)).then((r) => r.edits),
    streamMessage: (ref: SessionRef, input: SendMessageInput, signal?: AbortSignal) =>
      stream(routes.messages(ref.provider, ref.sessionId), input, signal),
    /** Starts a new session in the worktree with this first message; the `session` event names it. */
    streamNewSession: (worktreeId: string, input: NewSessionInput, signal?: AbortSignal) =>
      stream(routes.agentSessions(worktreeId), input, signal),
    streamReview: (worktreeId: string, input: ReviewRequest, signal?: AbortSignal) =>
      stream(routes.review(worktreeId), input, signal)
  }
}

export type { Against }
