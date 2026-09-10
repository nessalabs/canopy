import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Database } from 'better-sqlite3'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

const versionOf = (file: string): number => Number(file.split('_')[0])

/**
 * Applies every migrations/NNN_*.sql the database has not run, each in its own transaction.
 *
 * Progress is a ledger of file names, not a high-water mark: two files that share a number —
 * or one added below the highest number already applied — are invisible to a `version <=
 * applied` check, which is how a `004_db_lineage.sql` written after a database had reached
 * version 4 never ran, leaving the daemon reading columns that were not there. `user_version`
 * is still read to seed the ledger for databases written before it existed, and kept in step
 * so an older build reading the same file still skips what it already applied.
 */
export function migrate(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const record = db.prepare('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)')
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[])

  if (applied.size === 0) {
    const version = db.pragma('user_version', { simple: true }) as number
    for (const file of files.filter((file) => versionOf(file) <= version)) {
      record.run(file, Date.now())
      applied.add(file)
    }
  }

  for (const file of files) {
    if (applied.has(file)) continue
    db.transaction(() => {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
      record.run(file, Date.now())
      db.pragma(`user_version = ${versionOf(file)}`)
    })()
  }
}
