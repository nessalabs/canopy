import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Database } from 'better-sqlite3'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/** Applies migrations/NNN_*.sql above PRAGMA user_version, each in its own transaction. */
export function migrate(db: Database): void {
  const applied = db.pragma('user_version', { simple: true }) as number
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const version = Number(file.split('_')[0])
    if (version <= applied) continue
    db.transaction(() => {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
      db.pragma(`user_version = ${version}`)
    })()
  }
}
