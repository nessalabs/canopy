import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanopyEvent } from '@canopy/shared'

import { createEventBus } from '../src/env/events/bus'
import { runGit } from '../src/git/exec'
import { createRepo } from '../src/git/repo'
import { WATCH_SUPPORTED, WatchService } from '../src/worktrees/watch'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The next files-changed event matching `where`, or a timeout. */
function nextEvent(events: CanopyEvent[], where: (event: Extract<CanopyEvent, { type: 'files-changed' }>) => boolean, timeoutMs = 4000): Promise<Extract<CanopyEvent, { type: 'files-changed' }>> {
  const start = Date.now()
  const seen = events.length
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const hit = events.slice(seen).find((event): event is Extract<CanopyEvent, { type: 'files-changed' }> => event.type === 'files-changed' && where(event))
      if (hit) resolve(hit)
      else if (Date.now() - start > timeoutMs) reject(new Error(`no files-changed event within ${timeoutMs}ms; saw ${JSON.stringify(events.slice(seen))}`))
      else setTimeout(poll, 25)
    }
    poll()
  })
}

describe.skipIf(!WATCH_SUPPORTED)('WatchService', () => {
  let fixture: FixtureRepo
  let events: CanopyEvent[]
  let watch: WatchService

  beforeEach(async () => {
    fixture = await createFixtureRepo()
    await fixture.commit({ '.gitignore': 'dist/\n', 'src/a.ts': 'export const a = 1\n' }, 'init')
    const bus = createEventBus()
    events = []
    bus.subscribe((event) => events.push(event))
    watch = new WatchService({
      worktrees: { location: () => ({ path: fixture.path, baseBranch: 'main', projectId: 'p' }) },
      repo: createRepo(runGit),
      events: bus
    })
    watch.ensure('wt')
    // FSEvents needs a moment before it reports; nothing written before that is seen.
    await settle(400)
  })

  afterEach(() => {
    watch.stopAll()
    fixture.cleanup()
  })

  it('reports an edit by path, and leaves out what git ignores', async () => {
    mkdirSync(join(fixture.path, 'dist'), { recursive: true })
    writeFileSync(join(fixture.path, 'dist', 'out.js'), 'built\n')
    writeFileSync(join(fixture.path, 'src', 'a.ts'), 'export const a = 2\n')
    const event = await nextEvent(events, (e) => e.paths.includes('src/a.ts'))
    expect(event.worktreeId).toBe('wt')
    expect(event.paths).not.toContain('dist/out.js')
    expect(event.truncated).toBe(false)
  })

  it('reports the repository moving when the index changes', async () => {
    writeFileSync(join(fixture.path, 'src', 'b.ts'), 'export const b = 1\n')
    await fixture.git('add', 'src/b.ts')
    const event = await nextEvent(events, (e) => e.git)
    expect(event.git).toBe(true)
  })

  it('watches a worktree once, and stops when it is removed', async () => {
    watch.ensure('wt')
    expect(watch.watching()).toEqual(['wt'])
    watch.stop('wt')
    expect(watch.watching()).toEqual([])
    writeFileSync(join(fixture.path, 'src', 'a.ts'), 'export const a = 3\n')
    await settle(600)
    expect(events.filter((event) => event.type === 'files-changed')).toEqual([])
  })
})
