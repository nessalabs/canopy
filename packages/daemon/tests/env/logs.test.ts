import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogStore, sinkFor } from '../../src/env/logs/store'

describe('log store', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-logs-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('appends, serves the tail from the ring and backfills from the file', async () => {
    const store = createLogStore(root, { ring: 5 })
    for (let i = 0; i < 50; i += 1) store.append('wt1', 'web', { stream: 'out', text: `line ${i}` })

    const tail = await store.read('wt1', 'web', 0, 3)
    expect(tail.lines.map((line) => line.text)).toEqual(['line 47', 'line 48', 'line 49'])
    expect(tail.truncated).toBe(true)
    expect(tail.nextOffset).toBe(50)

    const middle = await store.read('wt1', 'web', 10, 5)
    expect(middle.lines.map((line) => line.offset)).toEqual([10, 11, 12, 13, 14])
    expect(middle.truncated).toBe(false)
    expect(middle.nextOffset).toBe(15)

    const all = await store.read('wt1', 'web', 0, 100)
    expect(all.lines).toHaveLength(50)
    expect(all.truncated).toBe(false)
    await store.close()

    const file = readFileSync(join(root, 'wt1', 'logs', 'web.ndjson'), 'utf8').trim().split('\n')
    expect(file).toHaveLength(50)
    expect(JSON.parse(file[0] as string)).toMatchObject({ offset: 0, stream: 'out', text: 'line 0' })
  })

  it('recovers the next offset from disk in a fresh store instance', async () => {
    const first = createLogStore(root)
    first.append('wt1', 'provision', { stream: 'sys', text: 'a' })
    first.append('wt1', 'provision', { stream: 'sys', text: 'b' })
    await first.close()

    const second = createLogStore(root)
    const line = second.append('wt1', 'provision', { stream: 'out', text: 'c' })
    expect(line.offset).toBe(2)
    const read = await second.read('wt1', 'provision', 0, 10)
    expect(read.lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
    await second.close()
  })

  it('notifies subscribers and stops after unsubscribe', async () => {
    const store = createLogStore(root)
    const seen: string[] = []
    const off = store.subscribe('wt1', 'web', (line) => seen.push(line.text))
    store.append('wt1', 'web', { stream: 'out', text: 'one' })
    off()
    store.append('wt1', 'web', { stream: 'out', text: 'two' })
    expect(seen).toEqual(['one'])
    await store.close()
  })

  it('clears a stream but keeps counting offsets, and removes a worktree entirely', async () => {
    const store = createLogStore(root)
    store.append('wt1', 'web', { stream: 'out', text: 'before' })
    await store.clear('wt1', 'web')
    const empty = await store.read('wt1', 'web', 0, 10)
    expect(empty.lines).toEqual([])
    const next = store.append('wt1', 'web', { stream: 'out', text: 'after' })
    expect(next.offset).toBe(1)

    await store.remove('wt1')
    expect(() => readFileSync(join(root, 'wt1', 'logs', 'web.ndjson'), 'utf8')).toThrow()
    await store.close()
  })

  it('rotates past the size limit and reports the lost window as truncated', async () => {
    const store = createLogStore(root, { ring: 2, maxFileBytes: 400 })
    // Two flush batches: a batch is never split, so the second one is what triggers the rename.
    for (let i = 0; i < 20; i += 1) store.append('wt1', 'web', { stream: 'out', text: `line ${i}` })
    await store.read('wt1', 'web', 0, 1)
    for (let i = 20; i < 40; i += 1) store.append('wt1', 'web', { stream: 'out', text: `line ${i}` })
    const early = await store.read('wt1', 'web', 1, 5)
    expect(early.truncated).toBe(true)
    expect(early.lines.every((line) => line.offset >= 1)).toBe(true)
    await store.close()
  })

  it('splits sink writes into lines, normalises CRLF and truncates very long lines', async () => {
    const store = createLogStore(root)
    const sink = sinkFor(store, 'wt1', 'web')
    sink.out('one\r\ntwo\n')
    sink.err('partial')
    sink.sys('x'.repeat(20_000))

    const read = await store.read('wt1', 'web', 0, 10)
    expect(read.lines.map((line) => [line.stream, line.text.length > 40 ? `${line.text.length}` : line.text])).toEqual([
      ['out', 'one'],
      ['out', 'two'],
      ['err', 'partial'],
      ['sys', '16385']
    ])
    expect(read.lines[3]?.text.endsWith('…')).toBe(true)
    await store.close()
  })
})
