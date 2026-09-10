import { describe, expect, it } from 'vitest'

import { createDocker, parseMemUsage, parsePsLine, parseStatsLine } from '../../src/env/docker'

describe('docker parsers', () => {
  it('reads every memory unit docker stats prints', () => {
    expect(parseMemUsage('12.3MiB / 7.7GiB')).toBeCloseTo(12.3, 1)
    expect(parseMemUsage('1.5GiB / 7.7GiB')).toBeCloseTo(1536, 0)
    expect(parseMemUsage('512kB / 7.7GiB')).toBeCloseTo(0.5, 1)
    expect(parseMemUsage('1024KiB / 7.7GiB')).toBeCloseTo(1, 1)
    expect(parseMemUsage('2MB / 7.7GiB')).toBeCloseTo(1.9, 1)
    expect(parseMemUsage('900B')).toBe(0)
    expect(parseMemUsage('')).toBe(0)
    expect(parseMemUsage('n/a / n/a')).toBe(0)
  })

  it('turns a stats line into cpu percent and megabytes', () => {
    const line = JSON.stringify({ ID: 'abc123def456', Name: 'canopy-wt1-web', CPUPerc: '0.45%', MemUsage: '12.3MiB / 7.66GiB', MemPerc: '0.16%' })
    expect(parseStatsLine(line)).toEqual({ id: 'abc123def456', cpuPct: 0.5, memMb: 12.3 })
    expect(parseStatsLine(JSON.stringify({ Container: 'short', CPUPerc: '--', MemUsage: '0B / 0B' }))).toEqual({ id: 'short', cpuPct: 0, memMb: 0 })
    expect(parseStatsLine('not json')).toBeNull()
    expect(parseStatsLine(JSON.stringify({ CPUPerc: '1%' }))).toBeNull()
  })

  it('turns a ps line into a container summary with split labels', () => {
    const line = JSON.stringify({
      ID: 'abc123',
      Names: 'canopy-wt1-web',
      Image: 'node:22',
      State: 'running',
      Labels: 'canopy.managed=1,canopy.worktree=wt1,canopy.service=web'
    })
    expect(parsePsLine(line)).toEqual({
      id: 'abc123',
      name: 'canopy-wt1-web',
      image: 'node:22',
      state: 'running',
      labels: { 'canopy.managed': '1', 'canopy.worktree': 'wt1', 'canopy.service': 'web' }
    })
    expect(parsePsLine(JSON.stringify({ ID: 'x' }))).toEqual({ id: 'x', name: '', image: '', state: '', labels: {} })
    expect(parsePsLine('')).toBeNull()
  })
})

describe('docker helper', () => {
  it('reports unavailable for a binary that does not exist', async () => {
    const docker = createDocker({ bin: 'definitely-not-docker-canopy' })
    const info = await docker.info()
    expect(info).toEqual({ available: false, version: null, path: null })
    // Cached: a second call must not spawn anything either.
    expect(await docker.info()).toEqual(info)
  })

  it('never spawns docker stats for an empty id list', async () => {
    const docker = createDocker({ bin: 'definitely-not-docker-canopy' })
    expect(await docker.stats([])).toEqual(new Map())
  })

  it('streams lines from a piped process and resolves with the exit code', async () => {
    const shell = createDocker({ bin: process.execPath })
    const lines: Array<[string, string]> = []
    const result = await shell.stream(['-e', 'process.stdout.write("a\\nb\\n"); process.stderr.write("e1\\n"); process.exit(3)'], (stream, text) =>
      lines.push([stream, text])
    )
    expect(result.exitCode).toBe(3)
    expect(lines).toEqual([
      ['out', 'a'],
      ['out', 'b'],
      ['err', 'e1']
    ])
  })
})
