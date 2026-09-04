import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A Claude Code session that is open in a terminal right now.
 *
 * Every interactive `claude` process registers itself in `~/.claude/sessions/<pid>.json`. Canopy
 * only reads that registry — to tell the user a session is also live in a terminal, and that a turn
 * sent from here (through the Agent SDK) will not appear in that terminal until it resumes. Canopy
 * no longer delivers prompts over the session's inbox socket: those arrive as *peer* messages
 * ("Another Claude session sent a message…"), never as the user's own turn.
 */
export interface LiveSession {
  pid: number
  sessionId: string
  cwd?: string
  name?: string
  status?: string
  socketPath: string
}

interface RegistryEntry {
  pid?: number
  sessionId?: string
  cwd?: string
  kind?: string
  entrypoint?: string
  name?: string
  status?: string
  messagingSocketPath?: string
}

const sessionsDir = (): string => join(homedir(), '.claude', 'sessions')

/** The registry entry of a terminal session, or undefined for headless (SDK) and stale records. */
export function parseRegistryEntry(json: string): LiveSession | undefined {
  let entry: RegistryEntry
  try {
    entry = JSON.parse(json) as RegistryEntry
  } catch {
    return undefined
  }
  const { pid, sessionId, messagingSocketPath: socketPath } = entry
  if (entry.kind !== 'interactive' || entry.entrypoint !== 'cli') return undefined
  if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof socketPath !== 'string') return undefined
  return { pid, sessionId, socketPath, cwd: entry.cwd, name: entry.name, status: entry.status }
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** Terminal sessions whose process and socket are both still there. */
export async function liveSessions(): Promise<LiveSession[]> {
  let files: string[]
  try {
    files = (await readdir(sessionsDir())).filter((file) => file.endsWith('.json'))
  } catch {
    return []
  }
  const entries = await Promise.all(files.map((file) => readFile(join(sessionsDir(), file), 'utf8').then(parseRegistryEntry, () => undefined)))
  const candidates = entries.filter((entry): entry is LiveSession => entry !== undefined && processAlive(entry.pid))
  const reachable = await Promise.all(candidates.map((entry) => exists(entry.socketPath)))
  return candidates.filter((_, index) => reachable[index])
}

export const liveSessionFor = async (sessionId: string): Promise<LiveSession | undefined> =>
  (await liveSessions()).find((entry) => entry.sessionId === sessionId)
