import { describe, expect, it } from 'vitest'

import { classifyLocalAnswer, commandOf, formatTokenCount, markdownTables, parseContextReport, parseMcpSummary, parseModelReport, parseSkillDoctor, parseTokenCount } from '../src/lib/local-answers'

// Verbatim answers from Claude Code 2.1.260 (session files, 2026-09-10), trimmed.
const CONTEXT = `## Context Usage

**Model:** claude-fable-5-1
**Tokens:** 11.1k / 1m (1%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 235 | 0.0% |
| System tools | 6.8k | 0.7% |
| MCP tools (deferred) | 6.1k | 0.6% |
| Skills | 2.7k | 0.3% |
| Messages | 40 | 0.0% |
| Free space | 955.9k | 95.6% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__plugin_playwright_playwright__browser_click | plugin_playwright_playwright | 321 |
| mcp__plugin_playwright_playwright__browser_close | plugin_playwright_playwright | 81 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| food-health-check | User | ~150 |
| dataviz | Built-in | ~480 |`

const SKILL_DOCTOR = `Skills loaded this session

  skill                            source           context  7d tokens   uses  last used
  prithvi-workshop-care            userSettings        < 20          -     0×  never
  frontend-design:frontend-design  frontend-design      ~80          -     1×  16 days
  ship                             userSettings         ~30       3.7m    16×  2 days`

const MODEL = 'Current model: `Haiku 4.5` (effort: xhigh)\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.'

describe('token counts', () => {
  it('reads the CLI\'s compact numbers both ways', () => {
    expect(parseTokenCount('6.8k')).toBe(6800)
    expect(parseTokenCount('1m')).toBe(1_000_000)
    expect(parseTokenCount('~150')).toBe(150)
    expect(parseTokenCount('3.7m')).toBe(3_700_000)
    expect(parseTokenCount('-')).toBeNull()
    expect(formatTokenCount(6800)).toBe('6.8k')
    expect(formatTokenCount(955_900)).toBe('955.9k')
    expect(formatTokenCount(1_000_000)).toBe('1m')
    expect(formatTokenCount(235)).toBe('235')
  })
})

describe('parseContextReport', () => {
  it('splits the window into what occupies it, free space and the buffer, and keeps the detail tables', () => {
    const report = parseContextReport(CONTEXT)
    expect(report).toMatchObject({ model: 'claude-fable-5-1', used: 11_100, limit: 1_000_000, percent: 1 })
    expect(report?.categories.map((c) => c.name)).toEqual(['System prompt', 'System tools', 'MCP tools (deferred)', 'Skills', 'Messages'])
    expect(report?.categories[1]).toEqual({ name: 'System tools', tokens: 6800, percent: 0.7 })
    expect(report?.free).toEqual({ name: 'Free space', tokens: 955_900, percent: 95.6 })
    expect(report?.buffer?.tokens).toBe(33_000)
    expect(report?.details.map((table) => [table.title, table.rows.length])).toEqual([
      ['MCP Tools', 2],
      ['Skills', 2]
    ])
    expect(report?.details[0]?.columns).toEqual(['Tool', 'Server', 'Tokens'])
  })

  it('is not fooled by other markdown with tables', () => {
    expect(parseContextReport('## Report\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBeNull()
    expect(markdownTables('no tables here')).toEqual([])
  })
})

describe('parseSkillDoctor', () => {
  it('turns the aligned text table into rows', () => {
    const report = parseSkillDoctor(SKILL_DOCTOR)
    expect(report?.title).toBe('Skills loaded this session')
    expect(report?.skills).toEqual([
      { skill: 'prithvi-workshop-care', source: 'userSettings', context: '< 20', tokens7d: null, uses: 0, lastUsed: 'never' },
      { skill: 'frontend-design:frontend-design', source: 'frontend-design', context: '~80', tokens7d: null, uses: 1, lastUsed: '16 days' },
      { skill: 'ship', source: 'userSettings', context: '~30', tokens7d: 3_700_000, uses: 16, lastUsed: '2 days' }
    ])
    expect(parseSkillDoctor('No skills loaded.')).toBeNull()
  })
})

describe('parseModelReport / parseMcpSummary', () => {
  it('reads the current model, effort and the aliases on offer', () => {
    expect(parseModelReport(MODEL)).toEqual({
      current: 'Haiku 4.5',
      effort: 'xhigh',
      available: ['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan', 'default']
    })
    expect(parseModelReport('Current model: `Sonnet 5`')).toEqual({ current: 'Sonnet 5', available: [] })
  })

  it('reads the MCP counts', () => {
    expect(parseMcpSummary('4 MCP server(s): 1 connected, 3 not connected, 0 disabled. Use `/mcp` in the terminal for details.')).toEqual({
      total: 4,
      connected: 1,
      notConnected: 3,
      disabled: 0
    })
  })
})

describe('classifyLocalAnswer', () => {
  it('names the card each answer gets', () => {
    expect(classifyLocalAnswer(CONTEXT, '/context')?.kind).toBe('context')
    expect(classifyLocalAnswer(SKILL_DOCTOR, '/skill-doctor')?.kind).toBe('skills')
    expect(classifyLocalAnswer(MODEL, '/model')?.kind).toBe('model')
    expect(classifyLocalAnswer('4 MCP server(s): 1 connected, 3 not connected, 0 disabled.', '/mcp')?.kind).toBe('mcp')
  })

  it('makes a note of a one-line built-in answer, but not of the model\'s own short reply', () => {
    expect(classifyLocalAnswer('Usage: /effort <low|medium|high|xhigh|max|auto>', '/effort')).toEqual({ kind: 'note', text: 'Usage: /effort <low|medium|high|xhigh|max|auto>' })
    expect(classifyLocalAnswer('Session renamed to: cli-commands-reference', '/rename cli-commands-reference')?.kind).toBe('note')
    // A custom command expands into a real turn; its one-word reply is the model talking.
    expect(classifyLocalAnswer('PONG', '/ping')).toBeNull()
    expect(classifyLocalAnswer('Sure.', 'say sure')).toBeNull()
    expect(commandOf('/model opus')).toBe('model')
    expect(commandOf('hello')).toBeNull()
  })
})
