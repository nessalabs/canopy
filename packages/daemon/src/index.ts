import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureToken, loadConfig } from './config'
import { openDb } from './db'
import { buildServer } from './server'

const here = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string }

const config = loadConfig()
const token = ensureToken(config.tokenPath)
const app = await buildServer({ config, db: openDb(config.dbPath), token, version, logger: true })

await app.listen({ port: config.port, host: config.host })
app.log.info(`canopyd ${version} · state in ${config.home}`)
