import SqliteDatabase, { type Database } from 'better-sqlite3'

import { migrate } from './migrate'

export type { Database }

/** Opens (or creates) the state database and brings it to the current schema. */
export function openDb(path: string): Database {
  const db = new SqliteDatabase(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
