import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureToken, loadConfig } from './config'
import { openDb } from './db'
import { acquirePidLock } from './lib/pidfile'
import { buildServer } from './server'

const here = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string }

const config = loadConfig()
let releasePid: () => void
try {
  releasePid = acquirePidLock(config.home)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(3)
}
const token = ensureToken(config.tokenPath)
const app = await buildServer({ config, db: openDb(config.dbPath), token, version, logger: true })

await app.listen({ port: config.port, host: config.host })
app.log.info(`canopyd ${version} · state in ${config.home}`)

// Kill-and-respawn whatever the previous daemon left, then bring back worktrees desired running.
void app.services.environment.reconcile().catch((error: unknown) => app.log.error(error, 'reconcile failed'))

// Shutdown order matters: stop every supervised service first (bounded), then close the HTTP
// server with its long-lived SSE streams, then exit. Doing it the other way round leaves a
// zombie daemon that keeps restarting services while it waits for clients to disconnect.
let closing = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    app.log.info(`${signal}: stopping services and shutting down`)
    const hardExit = setTimeout(() => {
      app.log.error('shutdown did not finish in time — exiting')
      releasePid()
      process.exit(1)
    }, 30_000)
    hardExit.unref()
    void app.services.environment
      .shutdown()
      .catch((error: unknown) => app.log.error(error, 'environment shutdown failed'))
      .then(() => app.close())
      .catch(() => undefined)
      .finally(() => {
        releasePid()
        process.exit(0)
      })
  })
}
