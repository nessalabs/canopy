import type { EditDiffsService } from '../agents/edit-diffs/service'
import type { CommitService } from '../commit/service'
import type { AgentRegistry } from '../agents/registry'
import type { DaemonConfig } from '../config'
import type { EnvironmentService } from '../env/service'
import type { EventBus, LogStore } from '../env/types'
import type { ProjectsService } from '../projects/service'
import type { ReviewService } from '../review/service'
import type { HistoryService } from '../worktrees/history'
import type { MergeService } from '../worktrees/merge'
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
  merges: MergeService
  review: ReviewService
  agents: AgentRegistry
  editDiffs: EditDiffsService
  environment: EnvironmentService
  logs: LogStore
  events: EventBus
}
