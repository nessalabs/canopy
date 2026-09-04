import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A Claude Code session that is open in a terminal right now.
 *
 * Every interactive `claude` process registers itself in `~/.claude/sessions/<pid>.json`
 * with a Unix messaging socket, and accepts newline-delimited JSON frames on it — the
 * channel one local Claude session uses to message another. Handing a prompt to that
 * process, rather than resuming the session in a second process, means the terminal
 * shows the message live, and only one process ever writes the session file.
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

/** Re-reads a live session's registry record; `busy` while a turn runs, `idle` between turns. */
export async function liveStatus(pid: number): Promise<string | undefined> {
  const entry = await readFile(join(sessionsDir(), `${pid}.json`), 'utf8').then(parseRegistryEntry, () => undefined)
  return entry?.status
}

/** Claude Code names a session's peer key after its pid and the sha256 of its socket path. */
export const keyFileName = (pid: number, socketPath: string): string =>
  `${pid}.${createHash('sha256').update(socketPath).digest('hex')}.key`

async function peerToken(live: LiveSession): Promise<string | undefined> {
  try {
    const key = JSON.parse(await readFile(join(sessionsDir(), keyFileName(live.pid, live.socketPath)), 'utf8')) as { peerToken?: string }
    return key.peerToken
  } catch {
    return undefined
  }
}

/** A user prompt frame; `next` queues it behind the running turn, the way typing mid-turn does. */
export const promptFrame = (text: string): Record<string, unknown> => ({
  msg_id: randomUUID(),
  uuid: randomUUID(),
  type: 'user',
  message: { role: 'user', content: text },
  priority: 'next',
  from: 'canopy'
})

/** Writes the auth frame (when the key is readable) and the prompt to the session's socket. */
export async function deliver(live: LiveSession, text: string): Promise<void> {
  const token = await peerToken(live)
  const frames = [...(token ? [{ type: 'auth', token }] : []), promptFrame(text)]
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: live.socketPath })
    socket.once('error', reject)
    socket.once('connect', () => socket.end(frames.map((frame) => `${JSON.stringify(frame)}\n`).join('')))
    socket.once('close', () => resolve())
  })
}
