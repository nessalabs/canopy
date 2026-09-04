import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'

import type { AddCommentInput, AddProjectInput, CreateWorktreeInput, DiffSpec, SessionRef, UpdateProjectInput } from '@canopy/shared'

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

/** Lazy: only fetched once a file is expanded. */
export const useFilePatch = (worktreeId: string, spec: DiffSpec, path: string, enabled: boolean) => {
  const api = useApi()
  return useQuery({ queryKey: keys.filePatch(worktreeId, spec, path), queryFn: () => api.filePatch(worktreeId, spec, path), enabled })
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
