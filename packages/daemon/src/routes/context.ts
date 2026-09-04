import type { EditDiffsService } from '../agents/edit-diffs/service'
import type { AgentRegistry } from '../agents/registry'
import type { DaemonConfig } from '../config'
import type { ProjectsService } from '../projects/service'
import type { ReviewService } from '../review/service'
import type { HistoryService } from '../worktrees/history'
import type { WorktreesService } from '../worktrees/service'

/** Everything a route needs, built once in server.ts. */
export interface Services {
  config: DaemonConfig
  version: string
  projects: ProjectsService
  worktrees: WorktreesService
  history: HistoryService
  review: ReviewService
  agents: AgentRegistry
  editDiffs: EditDiffsService
}
