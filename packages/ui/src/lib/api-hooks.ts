import { useCallback, useRef } from 'react'
import { type UseMutationOptions, useInfiniteQuery, useIsMutating, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  AddCommentInput,
  AddProjectInput,
  AgentProvider,
  AdoptWorktreeInput,
  AppSettingsPatch,
  ChangesResponse,
  CommitInput,
  CreatePullRequestInput,
  PullRequestAction,
  PullRequestResponse,
  MergeInput,
  CreateWorktreeInput,
  ExcludeInput,
  StageHunksInput,
  StageInput,
  UnhideInput,
  DbSource,
  DestroyAllInput,
  DiffSpec,
  OpenInput,
  ProjectSettingsPatch,
  ProvisionInput,
  RewindInput,
  ServiceAction,
  SessionRef,
  UpdateProjectInput
} from '@canopy/shared'

import { useApi } from '../providers/api'
import { useDaemonCapabilities } from './daemon-capabilities'
import { keys } from './query-keys'

/** Status is derived from git on every read, so the list polls while the app is in front. */
const POLL_MS = 5000
/** How often the Changes tab asks again when the daemon is pushing file events: a safety net only. */
const WATCHED_POLL_MS = 60_000
/** A working-tree read stays fresh this long; the daemon's file events refresh it sooner. */
const FILE_STALE_MS = 30_000
const LOG_PAGE = 50

export const useProjects = () => {
  const api = useApi()
  return useQuery({ queryKey: keys.projects, queryFn: api.listProjects })
}

/** What a destroy left behind for this project; read when the Trash tab opens. */
export const useProjectTrash = (projectId: string, enabled = true) => {
  const api = useApi()
  return useQuery({ queryKey: keys.projectTrash(projectId), queryFn: () => api.projectTrash(projectId), enabled })
}

export const useBranches = (projectId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.branches(projectId), queryFn: () => api.listBranches(projectId) })
}

export const useWorktrees = () => {
  const api = useApi()
  return useQuery({ queryKey: keys.worktrees, queryFn: api.listWorktrees, refetchInterval: POLL_MS, refetchIntervalInBackground: false })
}

export const useWorktree = (id: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.worktree(id), queryFn: () => api.getWorktree(id), refetchInterval: POLL_MS })
}

/** Staging mutations are keyed on this so the poll can stand aside while one is in flight. */
const stageKey = (worktreeId: string) => ['stage', worktreeId] as const

export const useDiffFiles = (worktreeId: string, spec: DiffSpec) => {
  const api = useApi()
  // A poll that started before a checkbox was clicked can land after it and undo the optimistic
  // flip, so the interval pauses while a stage request is outstanding.
  const staging = useIsMutating({ mutationKey: stageKey(worktreeId) })
  // A daemon that watches the files says so; then the interval is a safety net, not the signal.
  const { watch } = useDaemonCapabilities()
  return useQuery({
    queryKey: keys.diffFiles(worktreeId, spec),
    queryFn: () => api.diffFiles(worktreeId, spec),
    refetchInterval: spec.kind === 'worktree' && staging === 0 ? (watch ? WATCHED_POLL_MS : POLL_MS) : false
  })
}

/**
 * Lazy: only fetched once a file is expanded. Held fresh for a poll interval because the
 * explorer remounts the content pane on every file switch — without it, clicking back through
 * files already read re-runs git for each one.
 */
export const useFilePatch = (worktreeId: string, spec: DiffSpec, path: string, enabled: boolean) => {
  const api = useApi()
  return useQuery({ queryKey: keys.filePatch(worktreeId, spec, path), queryFn: () => api.filePatch(worktreeId, spec, path), enabled, staleTime: POLL_MS })
}

/** Directory listings for every open directory of the worktree browser; each fetched once on expand. */
export const useTrees = (worktreeId: string, dirs: string[]) => {
  const api = useApi()
  return useQueries({
    queries: dirs.map((dir) => ({ queryKey: keys.tree(worktreeId, dir), queryFn: () => api.tree(worktreeId, dir), staleTime: 30_000 }))
  })
}

/** Every path in the worktree, for the open-anything picker; fetched the first time it opens. */
export const useWorktreeFiles = (worktreeId: string, enabled: boolean) => {
  const api = useApi()
  return useQuery({ queryKey: keys.worktreeFiles(worktreeId), queryFn: () => api.worktreeFiles(worktreeId), enabled, staleTime: 30_000 })
}

/**
 * A blob at a commit never changes, so it is read once. A working-tree read is refreshed by the
 * daemon's file events, with a timer as the fallback. Only a change in the data re-renders the
 * reader: a refetch that comes back equal is invisible, so a rendered doc is never re-parsed for
 * nothing.
 */
export const useFileContents = (worktreeId: string, path: string, rev: string | undefined, enabled: boolean) => {
  const api = useApi()
  return useQuery({
    queryKey: keys.fileContents(worktreeId, path, rev),
    queryFn: () => api.fileContents(worktreeId, path, rev),
    enabled,
    staleTime: rev === undefined ? FILE_STALE_MS : Infinity,
    notifyOnChangeProps: ['data', 'error', 'isPending']
  })
}

/** Reads a working-tree file into the cache ahead of a click, so opening it finds it there. */
export const usePrefetchFileContents = (worktreeId: string) => {
  const api = useApi()
  const queryClient = useQueryClient()
  return useCallback(
    (path: string) => {
      void queryClient.prefetchQuery({ queryKey: keys.fileContents(worktreeId, path), queryFn: () => api.fileContents(worktreeId, path), staleTime: FILE_STALE_MS })
    },
    [api, queryClient, worktreeId]
  )
}

export const useLog = (worktreeId: string) => {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: keys.log(worktreeId),
    queryFn: ({ pageParam }) => api.log(worktreeId, LOG_PAGE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * LOG_PAGE : undefined)
  })
}

export const useComments = (worktreeId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.comments(worktreeId), queryFn: () => api.listComments(worktreeId) })
}

/**
 * Polled, gently: a session's busy/idle state is read from its terminal and its hooks at listing
 * time, and a session working here from another checkout arrives by event, not by poll.
 */
export const useAgentSessions = (worktreeId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.sessions(worktreeId), queryFn: () => api.agentSessions(worktreeId), refetchInterval: POLL_MS, refetchIntervalInBackground: false })
}

/**
 * Sessions keep growing while a terminal agent works in them, so this polls — every few seconds
 * when a terminal has the session open — except while
 * `paused()` (a turn sent from here is streaming; the local copy renders until it lands).
 */
export const useTranscript = (ref: SessionRef | undefined, cwd: string, paused: () => boolean = () => false) => {
  const api = useApi()
  return useQuery({
    queryKey: ref ? keys.transcript(ref) : ['transcript', 'none'],
    queryFn: () => api.transcript(ref as SessionRef, cwd),
    enabled: ref !== undefined,
    refetchInterval: (query) => (paused() ? false : query.state.data?.openInTerminal ? 2_000 : 10_000),
    refetchIntervalInBackground: false
  })
}

/** Hook-recorded edits for a session; polled alongside the transcript so a live turn's writes appear as they land. */
export const useAgentEdits = (ref: SessionRef | undefined) => {
  const api = useApi()
  return useQuery({
    queryKey: ref ? keys.edits(ref) : ['agent-edits', 'none'],
    queryFn: () => api.agentEdits(ref as SessionRef),
    enabled: ref !== undefined,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false
  })
}

/**
 * What the provider says a session in this checkout can do: slash commands, skills, subagents,
 * models, MCP servers, hooks. The daemon probes the CLI for this, so it is read once and kept —
 * a finished turn invalidates it, because a live turn's own advertisement is fresher than a probe.
 */
export const useAgentCapabilities = (worktreeId: string, provider: AgentProvider | undefined, sessionId?: string) => {
  const api = useApi()
  return useQuery({
    queryKey: keys.capabilities(worktreeId, provider ?? 'none', sessionId),
    queryFn: () => api.agentCapabilities(worktreeId, provider as AgentProvider, { sessionId }),
    enabled: provider !== undefined,
    staleTime: 5 * 60_000,
    // A daemon that cannot reach the CLI will not answer on a second try either.
    retry: 1
  })
}

export const useProviders = () => {
  const api = useApi()
  return useQuery({ queryKey: keys.providers, queryFn: api.providers })
}

// ---------- mutations: each names the reads it invalidates ----------

type Keys = ReadonlyArray<readonly unknown[]>

function useInvalidating<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  invalidates: (vars: TVars) => Keys,
  options?: Pick<UseMutationOptions<TData, Error, TVars>, 'onSuccess'>
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data, vars, context, mutation) => {
      await Promise.all(invalidates(vars).map((queryKey) => queryClient.invalidateQueries({ queryKey })))
      await options?.onSuccess?.(data, vars, context, mutation)
    }
  })
}

export const useScanProject = () => {
  const api = useApi()
  return useMutation({ mutationFn: (path: string) => api.scanProject(path) })
}

export const useAddProject = () => {
  const api = useApi()
  return useInvalidating((input: AddProjectInput) => api.addProject(input), () => [keys.projects, keys.worktrees])
}

export const useUpdateProject = (id: string) => {
  const api = useApi()
  return useInvalidating((input: UpdateProjectInput) => api.updateProject(id, input), () => [keys.projects, keys.worktrees])
}

export const useRemoveProject = () => {
  const api = useApi()
  return useInvalidating((id: string) => api.removeProject(id), () => [keys.projects, keys.worktrees])
}

export const useCreateWorktree = (projectId: string) => {
  const api = useApi()
  return useInvalidating((input: CreateWorktreeInput) => api.createWorktree(projectId, input), () => [keys.worktrees])
}

export const useDestroyWorktree = () => {
  const api = useApi()
  return useInvalidating(({ id, force }: { id: string; force?: boolean }) => api.destroyWorktree(id, force), () => [keys.worktrees])
}

export const useAddComment = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((input: AddCommentInput) => api.addComment(worktreeId, input), () => [keys.comments(worktreeId)])
}

export const useDeleteComment = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((commentId: string) => api.deleteComment(worktreeId, commentId), () => [keys.comments(worktreeId)])
}

export const usePinSession = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((ref: SessionRef) => api.pinSession(worktreeId, ref), () => [keys.sessions(worktreeId)])
}

// =====================================================================================
// Environment & resources
// =====================================================================================

export const useHost = () => {
  const api = useApi()
  return useQuery({ queryKey: keys.host, queryFn: api.host, staleTime: 60_000 })
}

export const useAppSettings = () => {
  const api = useApi()
  return useQuery({ queryKey: keys.appSettings, queryFn: api.appSettings, staleTime: 60_000 })
}

export const useUpdateAppSettings = () => {
  const api = useApi()
  return useInvalidating((patch: AppSettingsPatch) => api.updateAppSettings(patch), () => [keys.appSettings])
}

export const useProjectSettings = (projectId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.projectSettings(projectId), queryFn: () => api.projectSettings(projectId) })
}

export const useUpdateProjectSettings = (projectId: string) => {
  const api = useApi()
  return useInvalidating((patch: ProjectSettingsPatch) => api.updateProjectSettings(projectId, patch), () => [
    keys.projectSettings(projectId),
    keys.projectEnvironment(projectId),
    keys.projects
  ])
}

export const useProjectConfig = (projectId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.projectConfig(projectId), queryFn: () => api.projectConfig(projectId) })
}

export const useWriteProjectConfig = (projectId: string) => {
  const api = useApi()
  return useInvalidating((raw: string) => api.writeProjectConfig(projectId, raw), () => [keys.projectConfig(projectId), keys.projectEnvironment(projectId), keys.projects, keys.worktrees])
}

export const useScaffoldProjectConfig = (projectId: string) => {
  const api = useApi()
  return useMutation({ mutationFn: () => api.scaffoldProjectConfig(projectId) })
}

export const useProjectEnvironment = (projectId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.projectEnvironment(projectId), queryFn: () => api.projectEnvironment(projectId) })
}

export const useStopAllWorktrees = (projectId: string) => {
  const api = useApi()
  return useInvalidating((_: void) => api.stopAllWorktrees(projectId), () => [keys.worktrees])
}

export const useDestroyAllWorktrees = (projectId: string) => {
  const api = useApi()
  return useInvalidating((input: DestroyAllInput) => api.destroyAllWorktrees(projectId, input), () => [keys.worktrees, keys.projects])
}

export const useAdoptWorktree = () => {
  const api = useApi()
  return useInvalidating((input: AdoptWorktreeInput) => api.adoptWorktree(input), () => [keys.worktrees])
}

/** Start / stop / restart every service of a worktree. The environment event stream carries the follow-up. */
export const useWorktreeLifecycle = (worktreeId: string) => {
  const api = useApi()
  const actions = { start: api.startWorktree, stop: api.stopWorktree, restart: api.restartWorktree }
  return useInvalidating((action: 'start' | 'stop' | 'restart') => actions[action](worktreeId), () => [keys.worktree(worktreeId), keys.worktrees])
}

export const useProvisionWorktree = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((input: ProvisionInput) => api.provisionWorktree(worktreeId, input), () => [keys.worktree(worktreeId), keys.worktrees])
}

export const useRegenerateEnvFile = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating(() => api.regenerateEnvFile(worktreeId), () => [keys.worktree(worktreeId)])
}

export const useOpenWorktree = (worktreeId: string) => {
  const api = useApi()
  return useMutation({ mutationFn: (input: OpenInput) => api.openWorktree(worktreeId, input) })
}

export const useServiceAction = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating(({ service, action }: { service: string; action: ServiceAction }) => api.serviceAction(worktreeId, service, action), () => [keys.worktree(worktreeId), keys.worktrees])
}

export const useResetDatabase = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating(({ name, from }: { name: string; from?: DbSource }) => api.resetDatabase(worktreeId, name, { from }), () => [keys.worktree(worktreeId)])
}

export const useRefreshProjectDatabase = (projectId: string) => {
  const api = useApi()
  return useMutation({ mutationFn: (db: string) => api.refreshProjectDatabase(projectId, db) })
}

/** Backfill for the resources tab; live samples arrive through the event stream (see events-provider). */
export const useResourcesBackfill = (worktreeId: string, enabled = true) => {
  const api = useApi()
  return useQuery({ queryKey: keys.resources(worktreeId), queryFn: () => api.worktreeResources(worktreeId), enabled, staleTime: Number.POSITIVE_INFINITY })
}

/** Puts a destroyed worktree back: the checkout, its branch, and the work still uncommitted. */
export const useRestoreFromTrash = (projectId: string) => {
  const api = useApi()
  return useInvalidating((entry: string) => api.restoreFromTrash(projectId, entry), () => [keys.projectTrash(projectId), keys.worktrees, keys.projects])
}

export const usePurgeFromTrash = (projectId: string) => {
  const api = useApi()
  return useInvalidating((entry: string) => api.purgeFromTrash(projectId, entry), () => [keys.projectTrash(projectId)])
}

export const useDestroyWorktreeWith = () => {
  const api = useApi()
  return useInvalidating(({ id, force, deleteBranch }: { id: string; force?: boolean; deleteBranch?: boolean }) => api.destroyWorktreeWith(id, { force, deleteBranch }), () => [keys.worktrees])
}

/** Directory listing for the folder picker; cached briefly so stepping back up is instant. */
export const useDirs = (path: string | undefined, hidden: boolean, enabled = true) => {
  const api = useApi()
  return useQuery({ queryKey: keys.dirs(path, hidden), queryFn: () => api.listDirs(path, hidden), enabled, staleTime: 15_000, placeholderData: (previous) => previous })
}

// =====================================================================================
// Commit panel — the checkbox is git's index, so every mutation here writes it
// =====================================================================================

/** The only spec the commit panel works against: you can stage against HEAD and nothing else. */
const HEAD_SPEC = { kind: 'worktree', against: 'head' } as const

/** Merges a queued toggle into one already waiting: the later word on a path wins. */
function mergeStage(into: { stage: Set<string>; unstage: Set<string> }, next: StageInput): void {
  for (const path of next.stage) {
    into.unstage.delete(path)
    into.stage.add(path)
  }
  for (const path of next.unstage) {
    into.stage.delete(path)
    into.unstage.add(path)
  }
}

/**
 * Checkbox toggles. Optimistic so a click lands instantly, and written back from the response,
 * which carries the whole refreshed list — so no follow-up fetch either.
 *
 * Two things keep a burst of clicks from feeling slow. The optimistic flip is written
 * synchronously rather than behind an awaited `cancelQueries`, so it never waits out a poll that
 * happened to be in the air. And only one request is ever outstanding: toggles made while it runs
 * are merged into a single follow-up, which both spares the daemon a queue of index writes it
 * would have to serialize anyway, and — because a response is only written back when nothing is
 * queued behind it — stops an earlier reply from flipping a later click back.
 */
export const useStage = (worktreeId: string) => {
  const api = useApi()
  const queryClient = useQueryClient()
  const key = keys.diffFiles(worktreeId, HEAD_SPEC)
  const queued = useRef<{ stage: Set<string>; unstage: Set<string> } | null>(null)
  const busy = useRef(false)

  const mutation = useMutation({
    mutationKey: ['stage', worktreeId],
    mutationFn: (input: StageInput) => api.stage(worktreeId, input),
    onSuccess: (fresh) => {
      // A queued toggle has already been drawn; this reply predates it and would undo it.
      if (!queued.current) queryClient.setQueryData(key, fresh)
    },
    onError: () => {
      queued.current = null
      void queryClient.invalidateQueries({ queryKey: key })
    }
  })

  const { mutate } = mutation
  const send = useCallback(
    (input: StageInput) => {
      busy.current = true
      mutate(input, {
        onSettled: () => {
          busy.current = false
          const next = queued.current
          queued.current = null
          if (next) send({ stage: [...next.stage], unstage: [...next.unstage] })
        }
      })
    },
    [mutate]
  )

  const toggle = useCallback(
    (input: StageInput) => {
      const stage = new Set(input.stage)
      const unstage = new Set(input.unstage)
      // Cancel is not awaited: it marks any in-flight read cancelled there and then, so the
      // write below is what the panel repaints from, this frame.
      void queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<ChangesResponse>(key)
      if (previous) {
        queryClient.setQueryData<ChangesResponse>(key, {
          ...previous,
          files: previous.files.map((file) =>
            stage.has(file.path) ? { ...file, staged: 'staged' as const } : unstage.has(file.path) ? { ...file, staged: 'unstaged' as const } : file
          )
        })
      }
      if (busy.current) {
        queued.current ??= { stage: new Set(), unstage: new Set() }
        mergeStage(queued.current, input)
        return
      }
      send(input)
    },
    [key, queryClient, send]
  )

  return { mutate: toggle, error: mutation.error, isPending: mutation.isPending }
}

/** Which hunks of a file are in the index. Read only while that file's hunk view is open. */
export const useHunkStates = (worktreeId: string, path: string | undefined, enabled: boolean) => {
  const api = useApi()
  return useQuery({
    queryKey: keys.hunkStates(worktreeId, path ?? ''),
    queryFn: () => api.hunkStates(worktreeId, path as string),
    enabled: enabled && path !== undefined,
    staleTime: POLL_MS
  })
}

export const useStageHunks = (worktreeId: string) => {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: ['stage', worktreeId],
    mutationFn: (input: StageHunksInput) => api.stageHunks(worktreeId, input),
    onSuccess: async (fresh, input) => {
      queryClient.setQueryData(keys.diffFiles(worktreeId, HEAD_SPEC), fresh)
      await queryClient.invalidateQueries({ queryKey: keys.hunkStates(worktreeId, input.path) })
    }
  })
}

/**
 * Committing moves HEAD, so it touches nearly every read: the diff, the log, and the worktree
 * rows that carry ahead/behind and the last-commit line. A pre-commit hook may also have
 * rewritten files, which is why the change list is refetched rather than assumed empty.
 */
export const useCommitChanges = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((input: CommitInput) => api.commitChanges(worktreeId, input), () => [
    keys.diffFiles(worktreeId, HEAD_SPEC),
    keys.log(worktreeId),
    keys.worktree(worktreeId),
    keys.worktrees
  ])
}

/** Landing the branch moves the base, so every "vs base" reading and the merged tick change. */
export const useMergeWorktree = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((input: MergeInput) => api.mergeWorktree(worktreeId, input), () => [
    ['diff-files', worktreeId],
    keys.log(worktreeId),
    keys.worktree(worktreeId),
    keys.worktrees
  ])
}

/**
 * Puts the files a turn changed back to how they were before it ran. A dry run only reports, so it
 * invalidates nothing; a real one rewrites the checkout, which every diff read of that worktree —
 * the Git tab's and the turn panel's tree diff alike — has to be told about. The transcript
 * is deliberately left alone: the conversation still happened.
 */
export const useRewindFiles = (worktreeId: string, ref: SessionRef | undefined) => {
  const api = useApi()
  return useInvalidating(
    (input: RewindInput) => (ref ? api.rewindFiles(ref, input) : Promise.reject(new Error('No agent session to rewind.'))),
    (input) => (input.dryRun ? [] : [['diff-files', worktreeId], keys.worktree(worktreeId), keys.worktrees])
  )
}

/** A PR's checks move while it is on screen, so the pane asks again now and then; GitHub is slow, so not often. */
const PR_POLL_MS = 60_000
/** While CI is running the pane is watched for the result, so it asks more often. */
const PR_RUNNING_POLL_MS = 15_000

const checksRunning = (data: PullRequestResponse | undefined): boolean => Boolean(data?.pr?.checks.some((check) => check.outcome === 'pending'))

/**
 * The Pull request pane's read. Only mounted while the pane is open (Radix unmounts hidden
 * tabs), so nothing talks to GitHub for a worktree nobody is looking at.
 */
export const usePullRequest = (worktreeId: string, enabled = true) => {
  const api = useApi()
  return useQuery({
    queryKey: keys.pullRequest(worktreeId),
    queryFn: () => api.pullRequest(worktreeId),
    enabled,
    staleTime: 30_000,
    refetchInterval: (query) => (checksRunning(query.state.data) ? PR_RUNNING_POLL_MS : PR_POLL_MS),
    refetchIntervalInBackground: false,
    // Kept long after the pane closes, so coming back shows the last answer at once while a
    // refresh runs; the daemon holds its own copy too, so that refresh is mostly local.
    gcTime: 30 * 60_000
  })
}

/** The Refresh button: waits for GitHub rather than taking what the daemon holds. */
export const useRefreshPullRequest = (worktreeId: string) => {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.pullRequest(worktreeId, true),
    onSuccess: (data) => queryClient.setQueryData(keys.pullRequest(worktreeId), data)
  })
}

/**
 * Merge, review, comment, ready, close, reopen, rerun. A merge moves the target and a review can
 * mark local comments as sent, so besides the PR itself the worktree, its diffs and its comments
 * are read again.
 */
export const usePullRequestAction = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((action: PullRequestAction) => api.pullRequestAction(worktreeId, action), () => [
    keys.pullRequest(worktreeId),
    keys.comments(worktreeId),
    keys.worktree(worktreeId),
    keys.worktrees,
    ['diff-files', worktreeId]
  ])
}

/**
 * The PR tab's quick path for local work: stage every changed file, commit, push. Choosing
 * files or hunks stays in the Changes view; this is for "all of it goes in the PR".
 */
export const useCommitAllAndPush = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating(
    async (input: { paths: string[]; summary: string; description?: string }) => {
      await api.stage(worktreeId, { stage: input.paths, unstage: [] })
      const commit = await api.commitChanges(worktreeId, { summary: input.summary, description: input.description, noVerify: false })
      await api.pushBranch(worktreeId)
      return commit
    },
    () => [keys.pullRequest(worktreeId), ['diff-files', worktreeId], keys.log(worktreeId), keys.worktree(worktreeId), keys.worktrees]
  )
}

/**
 * Starts the PR read when the pointer reaches the Pull request tab, so the answer (a round trip
 * to GitHub) is mostly in by the time the click lands. Still lazy: nothing asks until then.
 */
export const usePrefetchPullRequest = (worktreeId: string) => {
  const api = useApi()
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.prefetchQuery({ queryKey: keys.pullRequest(worktreeId), queryFn: () => api.pullRequest(worktreeId), staleTime: 30_000 })
  }, [api, queryClient, worktreeId])
}

/** Opening a PR pushes the branch too, so the worktree's own status is read again with it. */
export const useCreatePullRequest = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating((input: CreatePullRequestInput) => api.createPullRequest(worktreeId, input), () => [keys.pullRequest(worktreeId), keys.worktree(worktreeId)])
}

/**
 * The PR's inline review threads, for the Comments pane and the Files changed overlay. Read
 * only while a pane that shows them is open; the daemon holds them with the PR answer.
 */
export const usePullRequestThreads = (worktreeId: string, enabled: boolean) => {
  const api = useApi()
  return useQuery({
    queryKey: keys.pullRequestThreads(worktreeId),
    queryFn: () => api.pullRequestThreads(worktreeId),
    enabled,
    staleTime: 30_000,
    refetchInterval: PR_POLL_MS,
    refetchIntervalInBackground: false,
    gcTime: 30 * 60_000,
    // No PR, or no GitHub: the pane simply has nothing from GitHub to show.
    retry: false
  })
}

/** Read the first time a sidebar picker opens; the daemon keeps it for ten minutes, this keeps it for the session. */
export const usePullRequestOptions = (worktreeId: string, enabled: boolean) => {
  const api = useApi()
  return useQuery({ queryKey: keys.pullRequestOptions(worktreeId), queryFn: () => api.pullRequestOptions(worktreeId), enabled, staleTime: 10 * 60_000 })
}

/** Brings a PR's commits pushed from elsewhere into the repository, so their diffs can be read. */
export const useFetchPullRequest = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating(() => api.fetchPullRequest(worktreeId), () => [keys.pullRequest(worktreeId), ['diff-files', worktreeId]])
}

export const usePushBranch = (worktreeId: string) => {
  const api = useApi()
  return useInvalidating(() => api.pushBranch(worktreeId), () => [keys.pullRequest(worktreeId), keys.worktree(worktreeId)])
}

/** Locally hidden paths — its own read, so the changes poll never pays for it. */
export const useHidden = (worktreeId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.hidden(worktreeId), queryFn: () => api.hiddenPaths(worktreeId), staleTime: 60_000 })
}

const useHiding = <T>(worktreeId: string, call: (input: T) => Promise<unknown>) =>
  useInvalidating(call, () => [keys.hidden(worktreeId), keys.diffFiles(worktreeId, HEAD_SPEC)])

export const useExclude = (worktreeId: string) => {
  const api = useApi()
  return useHiding(worktreeId, (input: ExcludeInput) => api.excludePaths(worktreeId, input))
}

export const useUnhide = (worktreeId: string) => {
  const api = useApi()
  return useHiding(worktreeId, (input: UnhideInput) => api.unhidePaths(worktreeId, input))
}
