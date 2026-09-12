import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import SqliteDatabase, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../src/db/migrate'

const columns = (db: Database, table: string): string[] => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)
const ledger = (db: Database): string[] => db.prepare('SELECT name FROM schema_migrations ORDER BY name').pluck().all() as string[]

describe('migrate', () => {
  let dir: string
  let db: Database
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canopy-migrate-'))
    db = new SqliteDatabase(join(dir, 'state.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('brings a fresh database to the current schema', () => {
    migrate(db)
    expect(columns(db, 'db_instances')).toContain('forked_from_database')
    expect(ledger(db).length).toBeGreaterThan(0)
  })

  it('is a no-op on a database already migrated', () => {
    migrate(db)
    const before = ledger(db)
    migrate(db)
    expect(ledger(db)).toEqual(before)
  })

  /**
   * The bug this ledger exists for: a version-number runner marks a database "at 4" and then
   * skips a migration numbered 4 that arrives later, so the daemon reads columns that are not
   * there. Simulated by dropping the ledger and the late migration's columns.
   */
  it('applies a migration added below the version already reached', () => {
    migrate(db)
    // A database from before 005 has none of what came after it either.
    db.exec('DROP TABLE agent_session_worktrees')
    db.exec('DROP TABLE db_instances')
    db.exec(`CREATE TABLE db_instances (
      worktree_id TEXT NOT NULL, name TEXT NOT NULL, adapter TEXT NOT NULL, status TEXT NOT NULL,
      url TEXT, forked_from TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', size_mb REAL,
      seeded_at INTEGER, error TEXT, PRIMARY KEY (worktree_id, name))`)
    db.exec("INSERT INTO projects (id, path, name, default_base, detected_json, created_at, updated_at) VALUES ('p1', '/tmp/p1', 'p1', 'main', '{}', 0, 0)")
    db.exec("INSERT INTO worktrees (id, project_id, name, path, created_at, updated_at) VALUES ('w1', 'p1', 'main', '/tmp/p1', 0, 0)")
    db.exec("INSERT INTO db_instances (worktree_id, name, adapter, status, forked_from) VALUES ('w1', 'main', 'postgres', 'ready', 'seed template')")
    db.exec('DROP TABLE schema_migrations')
    db.pragma('user_version = 4')

    migrate(db)

    expect(columns(db, 'db_instances')).toContain('forked_from_database')
    expect(columns(db, 'db_instances')).toContain('forked_from_branch')
    expect(db.prepare('SELECT forked_from, forked_from_database FROM db_instances').all()).toEqual([{ forked_from: 'seed template', forked_from_database: null }])
    expect(ledger(db)).toContain('005_db_lineage.sql')
  })
})
