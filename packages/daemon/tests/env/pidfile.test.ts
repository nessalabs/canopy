import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquirePidLock } from '../../src/lib/pidfile'

describe('pid lock', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'canopy-pid-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('writes our pid, refuses a second daemon, and releases on exit', () => {
    const release = acquirePidLock(home)
    expect(readFileSync(join(home, 'canopyd.pid'), 'utf8').trim()).toBe(String(process.pid))
    // A "second daemon" in the same process sees a live owner (us) — the same check a real one would hit.
    writeFileSync(join(home, 'canopyd.pid'), `${process.ppid}\n`)
    expect(() => acquirePidLock(home)).toThrow(/another canopyd/)
    writeFileSync(join(home, 'canopyd.pid'), `${process.pid}\n`)
    release()
    expect(() => readFileSync(join(home, 'canopyd.pid'))).toThrow()
  })

  it('takes over a stale pid file', () => {
    writeFileSync(join(home, 'canopyd.pid'), '999999999\n')
    const release = acquirePidLock(home)
    expect(readFileSync(join(home, 'canopyd.pid'), 'utf8').trim()).toBe(String(process.pid))
    release()
  })
})
