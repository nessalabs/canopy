import type { DraftInput, TextDraft } from '@canopy/shared'

import type { EditDiffsService } from '../agents/edit-diffs/service'
import type { CommitService } from '../commit/service'
import type { PresenceService } from '../agents/presence'
import type { AgentRegistry } from '../agents/registry'
import type { TurnHub } from '../agents/turn-hub'
import type { SessionLister } from '../agents/sessions'
import type { DaemonConfig } from '../config'
import type { EnvironmentService } from '../env/service'
import type { EventBus, LogStore } from '../env/types'
import type { GitHubService } from '../github/service'
import type { ProjectsService } from '../projects/service'
import type { ReviewService } from '../review/service'
import type { DestroyJobsService } from '../worktrees/destroy-jobs'
import type { HistoryService } from '../worktrees/history'
import type { MergeService } from '../worktrees/merge'
import type { TrashService } from '../worktrees/trash'
import type { WatchService } from '../worktrees/watch'
import type { WorktreesService } from '../worktrees/service'

/** Everything a route needs, built once in server.ts. */
export interface Services {
  config: DaemonConfig
  version: string
  projects: ProjectsService
  worktrees: WorktreesService
  history: HistoryService
  watch: WatchService
  commits: CommitService
  draftText: (worktreeId: string, input: DraftInput) => Promise<TextDraft>
  merges: MergeService
  destroyJobs: DestroyJobsService
  github: GitHubService
  trash: TrashService
  review: ReviewService
  agents: AgentRegistry
  /** Agent turns in flight, which run to the end whether or not a client is following. */
  turns: TurnHub
  editDiffs: EditDiffsService
  presence: PresenceService
  sessions: SessionLister
  environment: EnvironmentService
  logs: LogStore
  events: EventBus
}
