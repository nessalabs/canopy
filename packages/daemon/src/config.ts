import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

const ConfigFile = z.object({
  port: z.number().int().positive().default(9483),
  host: z.string().default('127.0.0.1'),
  worktreeRoot: z.string().optional()
})

export interface DaemonConfig {
  home: string
  port: number
  host: string
  worktreeRoot: string
  dbPath: string
  tokenPath: string
  /** Built web client to serve at `/`, when present. */
  webDist?: string
}

const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, homedir())

function readConfigFile(path: string): z.infer<typeof ConfigFile> {
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ port: 9483, host: '127.0.0.1' }, null, 2) + '\n')
  }
  return ConfigFile.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** Resolves ~/.canopy (or CANOPY_HOME), creating it and a default config.json on first run. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const home = expandHome(env['CANOPY_HOME'] ?? '~/.canopy')
  mkdirSync(home, { recursive: true })
  const file = readConfigFile(join(home, 'config.json'))
  return {
    home,
    port: env['CANOPY_PORT'] ? Number(env['CANOPY_PORT']) : file.port,
    host: file.host,
    worktreeRoot: expandHome(file.worktreeRoot ?? join(home, 'worktrees')),
    dbPath: join(home, 'state.db'),
    tokenPath: join(home, 'token'),
    webDist: env['CANOPY_WEB_DIST']
  }
}

/** The shared bearer token; generated once, mode 0600. */
export function ensureToken(tokenPath: string): string {
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  }
  return readFileSync(tokenPath, 'utf8').trim()
}
