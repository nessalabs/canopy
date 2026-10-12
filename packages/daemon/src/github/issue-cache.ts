/**
 * The local copy of a repository's issues and PRs: their summaries, when they were last synced,
 * and the threads already read. GitHub is asked only for what changed since the last sync, and a
 * thread is read again only once its issue says it changed.
 */
import type { Database } from 'better-sqlite3'

import type { IssueFilter, IssueSummary, IssueThread } from '@canopy/shared'

type Row = { number: number; kind: IssueSummary['kind']; title: string; state: IssueSummary['state']; url: string; author: string | null; assignees: string; updated_at: string }

const toSummary = (row: Row): IssueSummary => ({
  number: row.number,
  kind: row.kind,
  title: row.title,
  state: row.state,
  url: row.url,
  author: row.author,
  assignees: row.assignees.split(' ').filter(Boolean),
  updatedAt: row.updated_at
})

/** Logins kept as ` a b `, so `LIKE '% a %'` matches one login and never part of another. */
const joinLogins = (logins: readonly string[]): string => (logins.length ? ` ${logins.join(' ')} ` : '')



/** `LIKE` treats these as wildcards; a title search means them literally. */
const escapeLike = (word: string): string => word.replace(/[\\%_]/g, (c) => `\\${c}`)

export class IssueCache {
  constructor(private readonly db: Database) {}

  syncedAt(repo: string): string | null {
    return (this.db.prepare('SELECT synced_at FROM github_issue_syncs WHERE repo = ?').pluck().get(repo) as string | undefined) ?? null
  }

  /** How many issues and PRs the copy holds, to compare with GitHub's own count. */
  count(repo: string): number {
    return this.db.prepare('SELECT COUNT(*) FROM github_issues WHERE repo = ?').pluck().get(repo) as number
  }

  /** Forgets one that GitHub no longer has here — deleted, or transferred to another repository. */
  remove(repo: string, number: number): void {
    this.db.prepare('DELETE FROM github_issues WHERE repo = ? AND number = ?').run(repo, number)
    this.db.prepare('DELETE FROM github_issue_threads WHERE repo = ? AND number = ?').run(repo, number)
  }

  /**
   * Stores what GitHub said. With `sync`, everything changed before `sync.at` is now known; a
   * `full` sync is the whole repository, so it replaces the copy and drops what GitHub no longer
   * has — issues deleted or transferred away.
   */
  save(repo: string, items: readonly IssueSummary[], sync?: { at: string; full: boolean }): void {
    const upsert = this.db.prepare(
      `INSERT INTO github_issues (repo, number, kind, title, state, url, author, assignees, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET kind = excluded.kind, title = excluded.title, state = excluded.state, url = excluded.url,
         author = excluded.author, assignees = excluded.assignees, updated_at = excluded.updated_at`
    )
    this.db.transaction(() => {
      if (sync?.full) this.db.prepare('DELETE FROM github_issues WHERE repo = ?').run(repo)
      for (const item of items) upsert.run(repo, item.number, item.kind, item.title, item.state, item.url, item.author, joinLogins(item.assignees), item.updatedAt)
      if (sync) this.db.prepare('INSERT INTO github_issue_syncs (repo, synced_at) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET synced_at = excluded.synced_at').run(repo, sync.at)
    })()
  }

  /** Everyone the repository's issues and PRs are assigned to, by name. */
  assignees(repo: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT assignees FROM github_issues WHERE repo = ? AND assignees != ''").pluck().all(repo) as string[]
    return [...new Set(rows.flatMap((logins) => logins.split(' ').filter(Boolean)))].sort((a, b) => a.localeCompare(b))
  }

  /** One kind, open only unless asked, assigned to someone if asked, matching a number or every word of the title; newest activity first. */
  search(repo: string, q: string, { kind, state, assignee }: IssueFilter, limit = 10): IssueSummary[] {
    const where = ['repo = ?', 'kind = ?']
    const params: Array<string | number> = [repo, kind]
    if (state === 'open') where.push("state = 'OPEN'")
    if (assignee) {
      where.push("assignees LIKE ? ESCAPE '\\'")
      params.push(`% ${escapeLike(assignee)} %`)
    }
    const number = /^#?(\d+)$/.exec(q.trim())?.[1]
    if (number) {
      where.push('number = ?')
      params.push(Number(number))
    } else {
      for (const word of q.trim().split(/\s+/).filter(Boolean)) {
        where.push("title LIKE ? ESCAPE '\\'")
        params.push(`%${escapeLike(word)}%`)
      }
    }
    const rows = this.db.prepare(`SELECT * FROM github_issues WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit) as Row[]
    return rows.map(toSummary)
  }

  summary(repo: string, number: number): IssueSummary | undefined {
    const row = this.db.prepare('SELECT * FROM github_issues WHERE repo = ? AND number = ?').get(repo, number) as Row | undefined
    return row && toSummary(row)
  }

  /** The thread as last read, if the issue has not changed since. */
  thread(repo: string, number: number, updatedAt: string): IssueThread | undefined {
    const json = this.db.prepare('SELECT thread_json FROM github_issue_threads WHERE repo = ? AND number = ? AND updated_at = ?').pluck().get(repo, number, updatedAt) as string | undefined
    return json ? (JSON.parse(json) as IssueThread) : undefined
  }

  saveThread(repo: string, thread: IssueThread): void {
    this.db
      .prepare(
        `INSERT INTO github_issue_threads (repo, number, updated_at, thread_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo, number) DO UPDATE SET updated_at = excluded.updated_at, thread_json = excluded.thread_json`
      )
      .run(repo, thread.number, thread.updatedAt, JSON.stringify(thread))
  }
}
