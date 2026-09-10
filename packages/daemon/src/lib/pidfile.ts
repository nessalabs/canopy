/**
 * One canopyd per CANOPY_HOME. Two daemons supervising the same worktrees restart each other's
 * services and interleave the same log files, so the second one must refuse to start.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Writes `<home>/canopyd.pid`; throws when another live daemon owns it. Returns the release function. */
export function acquirePidLock(home: string): () => void {
  const path = join(home, 'canopyd.pid')
  if (existsSync(path)) {
    const previous = Number(readFileSync(path, 'utf8').trim())
    if (previous && previous !== process.pid && alive(previous)) {
      throw new Error(`another canopyd (pid ${previous}) is running for ${home}; stop it first or use a different CANOPY_HOME`)
    }
  }
  writeFileSync(path, `${process.pid}\n`)
  return () => {
    try {
      if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path, { force: true })
    } catch {
      // already gone
    }
  }
}
