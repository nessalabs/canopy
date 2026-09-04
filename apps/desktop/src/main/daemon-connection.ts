import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DaemonConnection {
  url: string
  token: string
}

const DEFAULT_PORT = 9483

function canopyHome(): string {
  return process.env['CANOPY_HOME'] ?? join(homedir(), '.canopy')
}

function readPort(home: string): number {
  const configPath = join(home, 'config.json')
  if (!existsSync(configPath)) return DEFAULT_PORT
  const port = (JSON.parse(readFileSync(configPath, 'utf8')) as { port?: number }).port
  return port ?? DEFAULT_PORT
}

/**
 * The desktop app connects to the daemon the same way the CLI does: by reading the
 * token canopyd wrote on first run. Env overrides let it target a remote daemon.
 */
export function readDaemonConnection(): DaemonConnection | null {
  const envUrl = process.env['CANOPY_DAEMON_URL']
  const envToken = process.env['CANOPY_TOKEN']
  if (envUrl && envToken) return { url: envUrl, token: envToken }

  const home = canopyHome()
  const tokenPath = join(home, 'token')
  if (!existsSync(tokenPath)) return null
  return {
    url: envUrl ?? `http://127.0.0.1:${readPort(home)}`,
    token: envToken ?? readFileSync(tokenPath, 'utf8').trim()
  }
}
