/**
 * Exact per-tool-call edits: a worktree snapshot before and after every tool call that can
 * write, keyed by the call's id so the Agent tab can fold them into per-turn diffs. Hooks
 * deliver the before/after moments; git trees hold the content; SQLite holds the index.
 */
import type { Database } from 'better-sqlite3'

import type { AgentEdit, AgentProvider, RewindResult } from '@canopy/shared'

import { now } from '../../lib/ids'
import type { WorktreesService } from '../../worktrees/service'
import type { ClaudeHookPayload } from './hook'
import type { Snapshots } from './snapshots'
import { claudeWrittenFiles } from './written-files'

interface EditRow {
  provider: string
  session_id: string
  tool_use_id: string
  worktree_id: string
  path: string
  before_tree: string
  after_tree: string
  attributed: number
  at: number
}

const toEdit = (row: EditRow): AgentEdit => ({
  toolUseId: row.tool_use_id,
  worktreeId: row.worktree_id,
  path: row.path,
  beforeTree: row.before_tree,
  afterTree: row.after_tree,
  attributed: row.attributed === 1,
  at: row.at
})

interface Pending {
  worktreeId: string
  cwd: string
  tree: string
}

interface Deps {
  db: Database
  worktrees: WorktreesService
  snapshots: Snapshots
}

export class EditDiffsService {
  /** Pre-snapshots waiting for their PostToolUse, by tool_use_id. */
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: Deps) {}

  list(provider: AgentProvider, sessionId: string): AgentEdit[] {
    const rows = this.deps.db.prepare('SELECT * FROM agent_edits WHERE provider = ? AND session_id = ? ORDER BY at, path').all(provider, sessionId) as EditRow[]
    return rows.map(toEdit)
  }

  /**
   * Puts the whole checkout back to a snapshot Canopy's hooks took before a turn wrote anything.
   *
   * This is the wide mechanism, and the reason it exists: a provider's own checkpoints cover only
   * what its file tools wrote, while a snapshot is the worktree entire — so a file a `rm` removed
   * or an `echo >` created comes back too.
   *
   * The current state is snapshotted first. That costs one tree when nothing has changed, and it
   * means an unwanted rewind is itself undoable: the ref pinning that tree survives this call.
   *
   * The index is deliberately left where the user put it. Restoring the worktree from a tree is not
   * a claim about what they meant to stage, and Canopy's commit panel *is* the index — rewriting it
   * here would silently unstage (or stage) work the agent never touched.
   */
  async restore(cwd: string, tree: string, dryRun = false): Promise<RewindResult> {
    // A sha this repo does not hold as a tree is not one of ours, and `git restore --source` would
    // take almost anything: refusing by name is cheaper than finding out by damage.
    if (!(await this.deps.snapshots.isTree(cwd, tree))) return { source: 'snapshot', canRewind: false, error: `${tree} is not a snapshot of this worktree`, filesChanged: [] }

    const current = await this.deps.snapshots.take(cwd)
    const changes = await this.deps.snapshots.changes(cwd, tree, current)
    const { insertions, deletions } = await this.deps.snapshots.countLines(cwd, tree, current)
    const answer: RewindResult = { source: 'snapshot', canRewind: true, filesChanged: changes.map((change) => change.path), insertions, deletions }
    if (dryRun) return answer

    // `A` means the path is in the worktree today and was not in the snapshot: there is nothing to
    // restore it *to*, so putting the worktree back means the file goes. Everything else — changed,
    // or deleted since — is content the snapshot still holds.
    await this.deps.snapshots.removePaths(cwd, changes.filter((change) => change.status === 'A').map((change) => change.path))
    await this.deps.snapshots.restorePaths(cwd, tree, changes.filter((change) => change.status !== 'A').map((change) => change.path))
    return answer
  }

  /** One hook event. Unknown worktrees are ignored so hooks outside Canopy's projects cost nothing. */
  async onClaudeHook(payload: ClaudeHookPayload): Promise<void> {
    await HANDLERS[payload.hook_event_name](this, payload)
  }

  async pre(payload: ClaudeHookPayload): Promise<void> {
    const worktree = this.deps.worktrees.containing(payload.cwd)
    if (!worktree) return
    const tree = await this.deps.snapshots.take(worktree.path)
    this.pending.set(payload.tool_use_id, { worktreeId: worktree.id, cwd: worktree.path, tree })
  }

  async post(payload: ClaudeHookPayload): Promise<void> {
    const before = this.pending.get(payload.tool_use_id)
    this.pending.delete(payload.tool_use_id)
    if (!before) return
    const after = await this.deps.snapshots.take(before.cwd)
    const paths = await this.deps.snapshots.changedPaths(before.cwd, before.tree, after)
    if (paths.length === 0) return
    const named = new Set(claudeWrittenFiles(payload.tool_name, payload.tool_input, payload.cwd).map((abs) => abs.slice(before.cwd.length + 1)))
    const insert = this.deps.db.prepare(
      `INSERT OR REPLACE INTO agent_edits (provider, session_id, tool_use_id, worktree_id, path, before_tree, after_tree, attributed, at)
       VALUES ('claude', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const at = now()
    this.deps.db.transaction(() => {
      for (const path of paths) insert.run(payload.session_id, payload.tool_use_id, before.worktreeId, path, before.tree, after, named.has(path) ? 1 : 0, at)
    })()
  }
}

/** Event name → handler; the hook matcher already chose which tools reach us. */
const HANDLERS: Record<ClaudeHookPayload['hook_event_name'], (service: EditDiffsService, payload: ClaudeHookPayload) => Promise<void>> = {
  PreToolUse: (service, payload) => service.pre(payload),
  PostToolUse: (service, payload) => service.post(payload)
}
