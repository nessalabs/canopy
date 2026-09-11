import { describe, expect, it } from 'vitest'

import { formatCount, looksLikeUsageReport, parseUsageReport, usageSeverity } from '../src/lib/usage-report'

// Verbatim from a `/usage` answer on Claude Code 2.1.260 (session file, 2026-09-10).
const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 24% used · resets Sep 10 at 11:20pm (America/Chicago)
Current week (all models): 17% used · resets Sep 13 at 7pm (America/Chicago)
Current week (Fable): 24% used · resets Sep 13 at 7pm (America/Chicago)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 1319 requests · 20 sessions
  65% of your usage was at >150k context
  64% of your usage came from subagent-heavy sessions
  Top skills: /artifact-design 1%, /artifact-diagramming 1%, /self-review 1%
  Top subagents: general-purpose 8%, self-review 4%, Explore 3%, fork 2%
  Top MCP servers: plugin:playwright:playwright 2%

Last 7d · 3511 requests · 47 sessions
  74% of your usage came from subagent-heavy sessions
  70% of your usage was at >150k context
  Top skills: /artifact-diagramming 1%, /artifact-design 1%, /self-review 1%, /writing-github-issues 1%, /ship 1%
  Top subagents: general-purpose 15%, Explore 2%, self-review 1%, Plan 1%, fork 1%
  Top MCP servers: plugin:playwright:playwright 7%`

describe('parseUsageReport', () => {
  it('reads the windows, the caveat and both periods out of the CLI template', () => {
    const report = parseUsageReport(SAMPLE)
    expect(report).not.toBeNull()
    expect(report?.plan).toBe('You are currently using your subscription to power your Claude Code usage')
    expect(report?.windows).toEqual([
      { label: 'Current session', percent: 24, resetsAt: 'Sep 10 at 11:20pm', zone: 'America/Chicago' },
      { label: 'Current week (all models)', percent: 17, resetsAt: 'Sep 13 at 7pm', zone: 'America/Chicago' },
      { label: 'Current week (Fable)', percent: 24, resetsAt: 'Sep 13 at 7pm', zone: 'America/Chicago' }
    ])
    expect(report?.note).toMatch(/^Approximate, based on local sessions/)
    expect(report?.periods.map((period) => period.label)).toEqual(['Last 24h', 'Last 7d'])

    const day = report?.periods[0]
    expect(day).toMatchObject({ requests: 1319, sessions: 20 })
    expect(day?.behaviors).toEqual([
      { percent: 65, what: 'at >150k context' },
      { percent: 64, what: 'subagent-heavy sessions' }
    ])
    expect(day?.skills).toEqual([
      { name: '/artifact-design', percent: 1 },
      { name: '/artifact-diagramming', percent: 1 },
      { name: '/self-review', percent: 1 }
    ])
    expect(day?.subagents[0]).toEqual({ name: 'general-purpose', percent: 8 })
    expect(day?.mcpServers).toEqual([{ name: 'plugin:playwright:playwright', percent: 2 }])
    expect(report?.periods[1]?.skills).toHaveLength(5)
  })

  it('keeps the windows when the contributing section is missing, and a reset time without a zone', () => {
    const report = parseUsageReport('You are on a plan\n\nCurrent session: 5% used · resets Sep 1 at 9am\nCurrent week (all models): 50% used')
    expect(report?.windows).toEqual([
      { label: 'Current session', percent: 5, resetsAt: 'Sep 1 at 9am' },
      { label: 'Current week (all models)', percent: 50 }
    ])
    expect(report?.periods).toEqual([])
    expect(report?.note).toBeUndefined()
  })

  it('leaves everything else alone', () => {
    expect(looksLikeUsageReport('Here is how usage works: 24% of the time…')).toBe(false)
    expect(parseUsageReport('## Context Usage\n\n**Tokens:** 16.8k / 1m (2%)')).toBeNull()
    expect(parseUsageReport('')).toBeNull()
  })

  it('grades a window by how close to the limit it is', () => {
    expect(usageSeverity(24)).toBe('ok')
    expect(usageSeverity(70)).toBe('warn')
    expect(usageSeverity(95)).toBe('critical')
    expect(formatCount(1319)).toBe('1,319')
  })
})
