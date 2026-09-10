import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'

import type {
  AddCommentInput,
  AddProjectInput,
  AdoptWorktreeInput,
  AppSettingsPatch,
  CreateWorktreeInput,
  DbSource,
  DestroyAllInput,
  DiffSpec,
  OpenInput,
  ProjectSettingsPatch,
  ProvisionInput,
  ServiceAction,
  SessionRef,
  UpdateProjectInput
} from '@canopy/shared'

import { useApi } from '../providers/api'
import { keys } from './query-keys'

/** Status is derived from git on every read, so the list polls while the app is in front. */
const POLL_MS = 5000
const LOG_PAGE = 50

export const useProjects = () => {
  const api = useApi()
  return useQuery({ queryKey: keys.projects, queryFn: api.listProjects })
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

export const useDiffFiles = (worktreeId: string, spec: DiffSpec) => {
  const api = useApi()
  return useQuery({
    queryKey: keys.diffFiles(worktreeId, spec),
    queryFn: () => api.diffFiles(worktreeId, spec),
    refetchInterval: spec.kind === 'worktree' ? POLL_MS : false
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

export const useFileContents = (worktreeId: string, path: string, rev: string | undefined, enabled: boolean) => {
  const api = useApi()
  return useQuery({ queryKey: keys.fileContents(worktreeId, path, rev), queryFn: () => api.fileContents(worktreeId, path, rev), enabled, staleTime: 10_000 })
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

export const useAgentSessions = (worktreeId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.sessions(worktreeId), queryFn: () => api.agentSessions(worktreeId) })
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
    keys.projectWtToml(projectId),
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

export const useProjectWtToml = (projectId: string) => {
  const api = useApi()
  return useQuery({ queryKey: keys.projectWtToml(projectId), queryFn: () => api.projectWtToml(projectId) })
}

export const useWriteProjectWtToml = (projectId: string) => {
  const api = useApi()
  return useInvalidating((_: void) => api.writeProjectWtToml(projectId), () => [keys.projectWtToml(projectId)])
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

export const useDestroyWorktreeWith = () => {
  const api = useApi()
  return useInvalidating(({ id, force, deleteBranch }: { id: string; force?: boolean; deleteBranch?: boolean }) => api.destroyWorktreeWith(id, { force, deleteBranch }), () => [keys.worktrees])
}

/** Directory listing for the folder picker; cached briefly so stepping back up is instant. */
export const useDirs = (path: string | undefined, hidden: boolean, enabled = true) => {
  const api = useApi()
  return useQuery({ queryKey: keys.dirs(path, hidden), queryFn: () => api.listDirs(path, hidden), enabled, staleTime: 15_000, placeholderData: (previous) => previous })
}
