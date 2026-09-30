import { describe, expect, it } from 'vitest'

import type { DbInstanceInfo, EnvVar, HostSample } from '@canopy/shared'

import { cpuScale, dotenv, lineage, logTime, memBreakdown, memScale, gitHref, linkQuery, niceScale, parseGitLink, parseTab, seriesVar, shortId, sparkline, uptime } from '../src/lib/environment-ui'
import { ENV_STATE_BADGE } from '../src/lib/status'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('tab deep links', () => {
  it('reads ?tab= out of a hash location', () => {
    expect(parseTab('#/worktrees/abc?tab=resources')).toBe('resources')
    expect(parseTab('#/worktrees/abc?foo=1&tab=agent')).toBe('agent')
    expect(parseTab('tab=environment')).toBe(undefined)
    expect(parseTab('?tab=environment')).toBe('environment')
    expect(parseTab('#/worktrees/abc?tab=git')).toBe('git')
    // The tab was called Git Diff once; old links still land on it.
    expect(parseTab('#/worktrees/abc?tab=gitdiff')).toBe('git')
  })

  it('reads a Git tab link, and drops what it does not know', () => {
    // How wouter's hash router actually writes a gitHref: the query ahead of the hash.
    const routed = { search: '?tab=git&pane=pr', hash: '#/worktrees/abc' }
    expect(parseGitLink(linkQuery(routed)).pane).toBe('pr')
    expect(parseTab(linkQuery(routed))).toBe('git')
    expect(linkQuery({ search: '?tab=git&pane=pr', hash: '#/worktrees/abc?tab=agent' })).toBe('#/worktrees/abc?tab=agent')
    expect(parseGitLink('#/worktrees/abc?tab=git&pane=pr')).toEqual({ pane: 'pr', against: undefined, commit: undefined })
    expect(parseGitLink('#/worktrees/abc?tab=git&pane=changes&against=base')).toEqual({ pane: 'changes', against: 'base', commit: undefined })
    expect(parseGitLink('#/worktrees/abc?tab=git&pane=history&commit=3ba83e1')).toEqual({ pane: 'history', against: undefined, commit: '3ba83e1' })
    expect(parseGitLink('#/worktrees/abc?tab=git&pane=nope&against=x&commit=HEAD~1')).toEqual({ pane: undefined, against: undefined, commit: undefined })
  })

  it('builds a Git tab link that reads back the same', () => {
    const href = gitHref('abc', { pane: 'history', commit: 'deadbeef' })
    expect(href).toBe('/worktrees/abc?tab=git&pane=history&commit=deadbeef')
    expect(parseGitLink(href)).toEqual({ pane: 'history', against: undefined, commit: 'deadbeef' })
  })

  it('ignores a missing or unknown tab', () => {
    expect(parseTab('#/worktrees/abc')).toBe(undefined)
    expect(parseTab('#/worktrees/abc?tab=')).toBe(undefined)
    expect(parseTab('#/worktrees/abc?tab=settings')).toBe(undefined)
    expect(parseTab('')).toBe(undefined)
  })
})

describe('database lineage', () => {
  const db = (over: Partial<DbInstanceInfo> = {}): DbInstanceInfo => ({
    name: 'main',
    adapter: 'postgres',
    status: 'ready',
    connectionUrl: 'postgresql://localhost/wt_main',
    envKey: 'DATABASE_URL',
    forkedFrom: 'worktree billing',
    forkedFromDatabase: 'wt_abc_main',
    forkedFromBranch: 'feature/billing',
    sizeMb: 7,
    seededAt: 1,
    detail: {},
    error: null,
    ...over
  })

  it('names the artifact the fork was copied from, with its branch', () => {
    expect(lineage(db())).toEqual({ value: 'wt_abc_main', hint: 'worktree billing · feature/billing' })
    expect(lineage(db({ forkedFromBranch: null }))).toEqual({ value: 'wt_abc_main', hint: 'worktree billing' })
    expect(lineage(db({ forkedFromDatabase: '/tmp/forks/app.sqlite' })).value).toBe('app.sqlite')
  })

  it('calls out a fork that silently started empty', () => {
    expect(lineage(db({ forkedFromDatabase: null }))).toEqual({ value: 'empty', hint: 'worktree billing was unavailable' })
  })

  /** A daemon older than this client sends no lineage at all — which is not a claim of "empty". */
  it('says nothing it does not know when the daemon sent no lineage', () => {
    const missing = db()
    delete (missing as { forkedFromDatabase?: string | null }).forkedFromDatabase
    delete (missing as { forkedFromBranch?: string | null }).forkedFromBranch
    expect(lineage(missing)).toEqual({ value: 'worktree billing', hint: 'lineage not recorded' })
  })

  it('does not claim a lineage before the fork exists', () => {
    expect(lineage(db({ status: 'forking' }))).toEqual({ value: 'worktree billing', hint: 'not forked yet' })
  })
})

describe('uptime', () => {
  const now = 1_000 * HOUR

  it('grows through seconds, minutes, hours and days', () => {
    expect(uptime(now - 9_000, now)).toBe('9s')
    expect(uptime(now - 59_999, now)).toBe('59s')
    expect(uptime(now - 9 * MINUTE, now)).toBe('9m')
    expect(uptime(now - 3 * HOUR - 4 * MINUTE, now)).toBe('3h 04m')
    expect(uptime(now - 50 * HOUR, now)).toBe('2d 2h')
  })

  it('has nothing to say about a service that never started', () => {
    expect(uptime(null, now)).toBe(null)
    expect(uptime(undefined, now)).toBe(null)
  })

  it('never runs backwards when a clock skews', () => {
    expect(uptime(now + 5_000, now)).toBe('0s')
  })
})

describe('env state badges', () => {
  it('keeps transitions quiet and failures loud', () => {
    expect(ENV_STATE_BADGE.running).toEqual({ label: 'Running', variant: 'default' })
    expect(ENV_STATE_BADGE.degraded.variant).toBe('destructive')
    expect(ENV_STATE_BADGE.error.variant).toBe('destructive')
    expect(ENV_STATE_BADGE.provisioning.variant).toBe('secondary')
    expect(ENV_STATE_BADGE.starting.variant).toBe('secondary')
    expect(ENV_STATE_BADGE.stopping.variant).toBe('secondary')
    expect(ENV_STATE_BADGE.creating.variant).toBe('secondary')
    expect(ENV_STATE_BADGE.destroying.variant).toBe('secondary')
    expect(ENV_STATE_BADGE.stopped.variant).toBe('outline')
    expect(ENV_STATE_BADGE.none.variant).toBe('outline')
  })
})

describe('meter scales', () => {
  it('rounds up to a nice ceiling', () => {
    expect(niceScale(0)).toBe(1)
    expect(niceScale(-4)).toBe(1)
    expect(niceScale(0.8)).toBe(1)
    expect(niceScale(37)).toBe(50)
    expect(niceScale(120)).toBe(200)
    expect(niceScale(2400)).toBe(2500)
  })

  it('gives cpu a floor of 20 and a ceiling of every core saturated', () => {
    expect(cpuScale([], 8)).toBe(20)
    expect(cpuScale([3, 1], 8)).toBe(20)
    expect(cpuScale([170], 8)).toBe(250)
    expect(cpuScale([180], 8)).toBe(500)
    expect(cpuScale([900], 4)).toBe(400)
    expect(cpuScale([50], 0)).toBe(100)
  })

  it('keeps a nearly idle service off the end of the memory bar', () => {
    expect(memScale([])).toBe(100)
    expect(memScale([12])).toBe(100)
    expect(memScale([900])).toBe(2000)
  })
})

describe('system memory breakdown', () => {
  const host: HostSample = { t: 1, cpuPct: 20, cores: [10, 30], memUsedMb: 6000, memTotalMb: 16000 }

  it('splits the machine into named consumers, other processes and free', () => {
    const bar = memBreakdown([{ name: 'web', memMb: 1000 }, { name: 'api', memMb: 500 }], host, 16000)
    expect(bar.usedMb).toBe(1500)
    expect(bar.otherMb).toBe(4500)
    expect(bar.freeMb).toBe(10000)
    expect(bar.segments.map((segment) => segment.kind)).toEqual(['series', 'series', 'other', 'free'])
    expect(bar.segments.reduce((sum, segment) => sum + segment.fraction, 0)).toBeCloseTo(1)
  })

  it('never paints a negative "other" when our sampling outruns the host tick', () => {
    const bar = memBreakdown([{ name: 'web', memMb: 9000 }], { ...host, memUsedMb: 2000 }, 16000)
    expect(bar.otherMb).toBe(0)
    expect(bar.usedMb + bar.freeMb).toBe(16000)
  })

  it("falls back to the sample's own total, then to a non-zero denominator", () => {
    expect(memBreakdown([{ name: 'web', memMb: 100 }], host, 0).totalMb).toBe(16000)
    expect(memBreakdown([{ name: 'web', memMb: 100 }], undefined, 0).totalMb).toBe(1)
  })

  it('treats a missing reading as zero', () => {
    const bar = memBreakdown([{ name: 'web' }], host, 16000)
    expect(bar.usedMb).toBe(0)
    expect(bar.segments[0].memMb).toBe(0)
  })
})

describe('sparkline', () => {
  it('scales bars against a nice ceiling and keeps a stub for zero', () => {
    const { scale, heights } = sparkline([0, 25, 50], 20)
    expect(scale).toBe(50)
    expect(heights).toEqual([2, 50, 100])
  })

  it('honours the floor so a quiet worktree does not look busy', () => {
    expect(sparkline([1, 2], 100).scale).toBe(100)
  })
})

describe('formatting', () => {
  it('renders a dotenv file, quoting only what needs it', () => {
    const env: EnvVar[] = [
      { key: 'PORT', value: '4000', source: 'port', secret: false },
      { key: 'NOTE', value: 'two words', source: 'yaml', secret: false },
      { key: 'PASSWORD', value: 'a"b', source: 'db', secret: true }
    ]
    expect(dotenv(env)).toBe('PORT=4000\nNOTE="two words"\nPASSWORD="a\\"b"')
  })

  it('prints log timestamps as local wall clock', () => {
    const at = new Date(2026, 8, 9, 4, 5, 6).getTime()
    expect(logTime(at)).toBe('04:05:06')
  })

  it('shortens container ids and wraps the chart palette', () => {
    expect(shortId('0123456789abcdef0123')).toBe('0123456789ab')
    expect(seriesVar(0)).toBe('var(--nessa-chart-1)')
    expect(seriesVar(6)).toBe('var(--nessa-chart-1)')
    expect(seriesVar(7)).toBe('var(--nessa-chart-2)')
  })
})
