/**
 * The local copy of a repository's issues and PRs: their summaries, when they were last synced,
 * and the threads already read. GitHub is asked only for what changed since the last sync, and a
 * thread is read again only once its issue says it changed.
 */
import type { Database } from 'better-sqlite3'

import type { IssueFilter, IssueSummary, IssueThread } from '@canopy/shared'

type Row = { number: number; kind: IssueSummary['kind']; title: string; state: IssueSummary['state']; url: string; author: string | null; updated_at: string }

const toSummary = (row: Row): IssueSummary => ({ number: row.number, kind: row.kind, title: row.title, state: row.state, url: row.url, author: row.author, updatedAt: row.updated_at })

/** `LIKE` treats these as wildcards; a title search means them literally. */
const escapeLike = (word: string): string => word.replace(/[\\%_]/g, (c) => `\\${c}`)

export class IssueCache {
  constructor(private readonly db: Database) {}

  syncedAt(repo: string): string | null {
    return (this.db.prepare('SELECT synced_at FROM github_issue_syncs WHERE repo = ?').pluck().get(repo) as string | undefined) ?? null
  }

  /** Stores what GitHub said, and — given `syncedAt` — that everything changed before it is now known. */
  save(repo: string, items: readonly IssueSummary[], syncedAt?: string): void {
    const upsert = this.db.prepare(
      `INSERT INTO github_issues (repo, number, kind, title, state, url, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET kind = excluded.kind, title = excluded.title, state = excluded.state, url = excluded.url, author = excluded.author, updated_at = excluded.updated_at`
    )
    this.db.transaction(() => {
      for (const item of items) upsert.run(repo, item.number, item.kind, item.title, item.state, item.url, item.author, item.updatedAt)
      if (syncedAt) this.db.prepare('INSERT INTO github_issue_syncs (repo, synced_at) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET synced_at = excluded.synced_at').run(repo, syncedAt)
    })()
  }

  /** One kind, open only unless asked, matching a number or every word of the title; newest activity first. */
  search(repo: string, q: string, { kind, state }: IssueFilter, limit = 10): IssueSummary[] {
    const where = ['repo = ?', 'kind = ?']
    const params: Array<string | number> = [repo, kind]
    if (state === 'open') where.push("state = 'OPEN'")
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
