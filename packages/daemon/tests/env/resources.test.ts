import { spawn } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import type { DockerHelper } from '../../src/env/types'
import { parseCpuTime, parsePs, ResourceSampler } from '../../src/env/resources/sampler'

/** Only `stats` is exercised here; the rest would need a daemon. */
const fakeDocker = (stats: Map<string, { cpuPct: number; memMb: number }>, calls: string[][] = []): DockerHelper =>
  ({
    async stats(ids: string[]) {
      calls.push(ids)
      return stats
    }
  }) as unknown as DockerHelper

describe('resource sampler', () => {
  const children: ReturnType<typeof spawn>[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
  })

  it('parses both the macOS and the Linux ps TIME formats', () => {
    expect(parseCpuTime('0:00.03')).toBeCloseTo(0.03)
    expect(parseCpuTime('12:34.56')).toBeCloseTo(754.56)
    expect(parseCpuTime('00:00:01')).toBe(1)
    expect(parseCpuTime('01:02:03')).toBe(3723)
    expect(parseCpuTime('1-02:03:04')).toBe(86_400 + 7384)
    expect(parseCpuTime('')).toBe(0)
    expect(parseCpuTime('nonsense')).toBe(0)
  })

  it('parses ps rows and skips malformed lines', () => {
    const stdout = ['  501     1   501  12345   0:00.03', ' 1234   501  1234   2048 1-02:03:04', 'garbage', ''].join('\n')
    expect(parsePs(stdout)).toEqual([
      { pid: 501, ppid: 1, pgid: 501, rssKb: 12345, cpuSeconds: 0.03 },
      { pid: 1234, ppid: 501, pgid: 1234, rssKb: 2048, cpuSeconds: 93_784 }
    ])
  })

  it('measures a real process group: memory now, cpu from the second tick on', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' })
    children.push(child)
    const pid = child.pid as number
    const sampler = new ResourceSampler(fakeDocker(new Map()))

    const first = await sampler.sampleProcesses([{ key: 'wt1/web', pid }])
    expect(first.get('wt1/web')?.cpuPct).toBe(0)
    expect(first.get('wt1/web')?.memMb).toBeGreaterThan(0)

    const second = await sampler.sampleProcesses([{ key: 'wt1/web', pid }, { key: 'wt1/dead', pid: 999_999 }])
    expect(second.get('wt1/web')?.memMb).toBeGreaterThan(0)
    expect(second.get('wt1/web')?.cpuPct).toBeGreaterThanOrEqual(0)
    expect(second.get('wt1/dead')).toEqual({ cpuPct: 0, memMb: 0 })
  })

  it('returns an empty map without spawning docker when there are no containers', async () => {
    const calls: string[][] = []
    const sampler = new ResourceSampler(fakeDocker(new Map([['abc', { cpuPct: 1, memMb: 2 }]]), calls))
    expect(await sampler.sampleContainers([])).toEqual(new Map())
    expect(calls).toEqual([])
    expect((await sampler.sampleContainers(['abc'])).get('abc')).toEqual({ cpuPct: 1, memMb: 2 })
    expect(calls).toEqual([['abc']])
  })

  it('samples the host, with zero cpu until there is a delta to measure', () => {
    const sampler = new ResourceSampler(fakeDocker(new Map()))
    const first = sampler.sampleHost()
    expect(first.cpuPct).toBe(0)
    expect(first.cores.every((core) => core === 0)).toBe(true)
    expect(first.memTotalMb).toBeGreaterThan(0)
    expect(first.memUsedMb).toBeGreaterThan(0)

    const second = sampler.sampleHost()
    expect(second.cores).toHaveLength(first.cores.length)
    expect(second.cpuPct).toBeGreaterThanOrEqual(0)
    expect(second.cpuPct).toBeLessThanOrEqual(100)
  })
})

describe('parseVmStat', () => {
  it('sums free, inactive, speculative and purgeable pages at the reported page size', async () => {
    const { parseVmStat } = await import('../../src/env/resources/sampler')
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               100.',
      'Pages active:                            5000.',
      'Pages inactive:                           200.',
      'Pages speculative:                         50.',
      'Pages throttled:                            0.',
      'Pages wired down:                        3000.',
      'Pages purgeable:                           50.'
    ].join('\n')
    expect(parseVmStat(out)).toBe((100 + 200 + 50 + 50) * 16384)
    expect(parseVmStat('garbage')).toBeNull()
  })
})
