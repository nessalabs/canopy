import { createServer, type Server } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDb, type Database } from '../../src/db'
import { hashPort, PortAllocator } from '../../src/env/ports/allocator'

const listen = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()))

describe('port allocator', () => {
  let db: Database
  const range: [number, number] = [45100, 45140]

  beforeEach(() => {
    db = openDb(':memory:')
    db.prepare('INSERT INTO projects (id, name, path, default_base, detected_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
      'p1',
      'proj',
      '/tmp/proj',
      'main',
      '{}',
      0,
      0
    )
    for (const id of ['wt1', 'wt2']) {
      db.prepare('INSERT INTO worktrees (id, project_id, name, path, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, 'p1', id, `/tmp/${id}`, 0, 0)
    }
  })
  afterEach(() => db.close())

  it('hashes a seed key into the range deterministically', () => {
    expect(hashPort('proj/main/web', range)).toBe(hashPort('proj/main/web', range))
    expect(hashPort('proj/main/web', range)).toBeGreaterThanOrEqual(range[0])
    expect(hashPort('proj/main/web', range)).toBeLessThanOrEqual(range[1])
    expect(hashPort('proj/main/web', range)).not.toBe(hashPort('proj/other/web', range))
  })

  it('is idempotent per (worktree, name) and never reuses a number', async () => {
    const allocator = new PortAllocator(db, range)
    const first = await allocator.allocate('wt1', 'web', { seedKey: 'proj/main/web' })
    const again = await allocator.allocate('wt1', 'web', { seedKey: 'proj/main/web' })
    expect(again).toBe(first)

    const other = await allocator.allocate('wt2', 'web', { seedKey: 'proj/main/web' })
    expect(other).not.toBe(first)

    expect(allocator.allocated('wt1')).toEqual({ web: first })
    expect(allocator.allAllocated()).toHaveLength(2)

    allocator.release('wt1', 'web')
    expect(allocator.allocated('wt1')).toEqual({})
    allocator.release('wt2')
    expect(allocator.allAllocated()).toEqual([])
  })

  it('honours preferred when it is inside the range and free', async () => {
    const allocator = new PortAllocator(db, range)
    expect(await allocator.allocate('wt1', 'api', { seedKey: 'x', preferred: 45123 })).toBe(45123)
    // Outside the range the preference is ignored, not an error.
    expect(await allocator.allocate('wt2', 'api', { seedKey: 'y', preferred: 80 })).not.toBe(80)
  })

  it('skips a port that is actually bound by something else', async () => {
    const allocator = new PortAllocator(db, range)
    const seed = 'proj/main/busy'
    const wanted = hashPort(seed, range)
    const server = await listen(wanted)
    try {
      expect(await allocator.isFree(wanted)).toBe(false)
      const port = await allocator.allocate('wt1', 'busy', { seedKey: seed })
      expect(port).not.toBe(wanted)
      expect(port).toBeGreaterThanOrEqual(range[0])
    } finally {
      await close(server)
    }
  })

  it('reports a conflict when the whole range is taken', async () => {
    const tiny: [number, number] = [45200, 45201]
    const allocator = new PortAllocator(db, tiny)
    await allocator.allocate('wt1', 'a', { seedKey: 'a' })
    await allocator.allocate('wt1', 'b', { seedKey: 'b' })
    await expect(allocator.allocate('wt2', 'c', { seedKey: 'c' })).rejects.toMatchObject({ status: 409, code: 'no_free_port' })
  })
})
